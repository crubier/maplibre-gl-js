import Point from '../util/point';
import loadGeometry from './load_geometry';
import toEvaluationFeature from './evaluation_feature';
import EXTENT from './extent';
import featureFilter from '../style-spec/feature_filter';
import TransferableGridIndex from '../util/transferable_grid_index';
import DictionaryCoder from '../util/dictionary_coder';
import vt from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import GeoJSONFeature from '../util/vectortile_to_geojson';
import {arraysIntersect, mapObject, extend} from '../util/util';
import {OverscaledTileID} from '../source/tile_id';
import {register} from '../util/web_worker_transfer';
import EvaluationParameters from '../style/evaluation_parameters';
import SourceFeatureState from '../source/source_state';
import {polygonIntersectsBox} from '../util/intersection_tests';
import {PossiblyEvaluated} from '../style/properties';
import {FeatureIndexArray} from './array_types';
import {mat4} from 'gl-matrix';

import type StyleLayer from '../style/style_layer';
import type {FeatureFilter} from '../style-spec/feature_filter';
import type Transform from '../geo/transform';
import type {FilterSpecification, PromoteIdSpecification} from '../style-spec/types';
import type {FeatureState} from '../style-spec/expression';
import type {VectorTileFeature, VectorTileLayer} from '@mapbox/vector-tile';

type QueryParameters = {
  scale: number;
  pixelPosMatrix: mat4;
  transform: Transform;
  tileSize: number;
  queryGeometry: Array<Point>;
  cameraQueryGeometry: Array<Point>;
  queryPadding: number;
  params: {
    filter: FilterSpecification;
    layers: Array<string>;
    availableImages: Array<string>;
  };
};

class FeatureIndex {
    tileID: OverscaledTileID;
    x: number;
    y: number;
    z: number;
    grid: TransferableGridIndex;
    grid3D: TransferableGridIndex;
    featureIndexArray: FeatureIndexArray;
    promoteId?: PromoteIdSpecification;

    rawTileData: ArrayBuffer;
    bucketLayerIDs: Array<Array<string>>;

    vtLayers: {[_: string]: VectorTileLayer};
    sourceLayerCoder: DictionaryCoder;

    constructor(tileID: OverscaledTileID, promoteId?: PromoteIdSpecification | null) {
        this.tileID = tileID;
        this.x = tileID.canonical.x;
        this.y = tileID.canonical.y;
        this.z = tileID.canonical.z;
        this.grid = new TransferableGridIndex(EXTENT, 16, 0);
        this.grid3D = new TransferableGridIndex(EXTENT, 16, 0);
        this.featureIndexArray = new FeatureIndexArray();
        this.promoteId = promoteId;
    }

    insert(feature: VectorTileFeature, geometry: Array<Array<Point>>, featureIndex: number, sourceLayerIndex: number, bucketIndex: number, is3D?: boolean) {
        const key = this.featureIndexArray.length;
        this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);

        const grid = is3D ? this.grid3D : this.grid;

        for (let r = 0; r < geometry.length; r++) {
            const ring = geometry[r];

            const bbox = [Infinity, Infinity, -Infinity, -Infinity];
            for (let i = 0; i < ring.length; i++) {
                const p = ring[i];
                bbox[0] = Math.min(bbox[0], p.x);
                bbox[1] = Math.min(bbox[1], p.y);
                bbox[2] = Math.max(bbox[2], p.x);
                bbox[3] = Math.max(bbox[3], p.y);
            }

            if (bbox[0] < EXTENT &&
                bbox[1] < EXTENT &&
                bbox[2] >= 0 &&
                bbox[3] >= 0) {
                grid.insert(key, bbox[0], bbox[1], bbox[2], bbox[3]);
            }
        }
    }

    loadVTLayers(): {[_: string]: VectorTileLayer} {
        if (!this.vtLayers) {
            this.vtLayers = new vt.VectorTile(new Protobuf(this.rawTileData)).layers;
            this.sourceLayerCoder = new DictionaryCoder(this.vtLayers ? Object.keys(this.vtLayers).sort() : ['_geojsonTileLayer']);
        }
        return this.vtLayers;
    }

    // Finds non-symbol features in this tile at a particular position.
    query(
      args: QueryParameters,
      styleLayers: {[_: string]: StyleLayer},
      serializedLayers: {[_: string]: any},
      sourceFeatureState: SourceFeatureState
    ): {[_: string]: Array<{featureIndex: number; feature: GeoJSONFeature}>} {
        this.loadVTLayers();

        const params = args.params || {} as { filter: any; layers: string[]; availableImages: string[] },
            pixelsToTileUnits = EXTENT / args.tileSize / args.scale,
            filter = featureFilter(params.filter);

        const queryGeometry = args.queryGeometry;
        const queryPadding = args.queryPadding * pixelsToTileUnits;

        const bounds = getBounds(queryGeometry);
        const matching = this.grid.query(bounds.minX - queryPadding, bounds.minY - queryPadding, bounds.maxX + queryPadding, bounds.maxY + queryPadding);

        const cameraBounds = getBounds(args.cameraQueryGeometry);
        const matching3D = this.grid3D.query(
                cameraBounds.minX - queryPadding, cameraBounds.minY - queryPadding, cameraBounds.maxX + queryPadding, cameraBounds.maxY + queryPadding,
                (bx1, by1, bx2, by2) => {
                    return polygonIntersectsBox(args.cameraQueryGeometry, bx1 - queryPadding, by1 - queryPadding, bx2 + queryPadding, by2 + queryPadding);
                });

        for (const key of matching3D) {
            matching.push(key);
        }

        matching.sort(topDownFeatureComparator);

        const result = {};
        let previousIndex;
        for (let k = 0; k < matching.length; k++) {
            const index = matching[k];

            // don't check the same feature more than once
            if (index === previousIndex) continue;
            previousIndex = index;

            const match = this.featureIndexArray.get(index);
            let featureGeometry = null;
            this.loadMatchingFeature(
                result,
                match.bucketIndex,
                match.sourceLayerIndex,
                match.featureIndex,
                filter,
                params.layers,
                params.availableImages,
                styleLayers,
                serializedLayers,
                sourceFeatureState,
                (feature: VectorTileFeature, styleLayer: StyleLayer, featureState: FeatureState) => { // eslint-disable-line no-loop-func
                    if (!featureGeometry) {
                        featureGeometry = loadGeometry(feature);
                    }

                    return styleLayer.queryIntersectsFeature(queryGeometry, feature, featureState, featureGeometry, this.z, args.transform, pixelsToTileUnits, args.pixelPosMatrix);
                }
            );
        }

        return result;
    }

    loadMatchingFeature(
        result: {
          [_: string]: Array<{
            featureIndex: number;
            feature: GeoJSONFeature;
            intersectionZ?: boolean | number;
          }>;
        },
        bucketIndex: number,
        sourceLayerIndex: number,
        featureIndex: number,
        filter: FeatureFilter,
        filterLayerIDs: Array<string>,
        availableImages: Array<string>,
        styleLayers: {[_: string]: StyleLayer},
        serializedLayers: {[_: string]: any},
        sourceFeatureState?: SourceFeatureState,
        intersectionTest?: (
          feature: VectorTileFeature,
          styleLayer: StyleLayer,
          featureState: any,
          id: string | number | void
        ) => boolean | number) {

        const layerIDs = this.bucketLayerIDs[bucketIndex];
        if (filterLayerIDs && !arraysIntersect(filterLayerIDs, layerIDs))
            return;

        const sourceLayerName = this.sourceLayerCoder.decode(sourceLayerIndex);
        const sourceLayer = this.vtLayers[sourceLayerName];
        const feature = sourceLayer.feature(featureIndex);

        if (filter.needGeometry) {
            const evaluationFeature = toEvaluationFeature(feature, true);
            if (!filter.filter(new EvaluationParameters(this.tileID.overscaledZ), evaluationFeature, this.tileID.canonical)) {
                return;
            }
        } else if (!filter.filter(new EvaluationParameters(this.tileID.overscaledZ), feature)) {
            return;
        }

        const id = this.getId(feature, sourceLayerName);

        for (let l = 0; l < layerIDs.length; l++) {
            const layerID = layerIDs[l];

            if (filterLayerIDs && filterLayerIDs.indexOf(layerID) < 0) {
                continue;
            }

            const styleLayer = styleLayers[layerID];

            if (!styleLayer) continue;

            let featureState = {};
            if (id && sourceFeatureState) {
                // `feature-state` expression evaluation requires feature state to be available
                featureState = sourceFeatureState.getState(styleLayer.sourceLayer || '_geojsonTileLayer', id);
            }

            const serializedLayer = extend({}, serializedLayers[layerID]);

            serializedLayer.paint = evaluateProperties(serializedLayer.paint, styleLayer.paint, feature, featureState, availableImages);
            serializedLayer.layout = evaluateProperties(serializedLayer.layout, styleLayer.layout, feature, featureState, availableImages);

            const intersectionZ = !intersectionTest || intersectionTest(feature, styleLayer, featureState);
            if (!intersectionZ) {
                // Only applied for non-symbol features
                continue;
            }

            const geojsonFeature = new GeoJSONFeature(feature, this.z, this.x, this.y, id);
            (geojsonFeature as any).layer = serializedLayer;
            let layerResult = result[layerID];
            if (layerResult === undefined) {
                layerResult = result[layerID] = [];
            }
            layerResult.push({featureIndex, feature: geojsonFeature, intersectionZ});
        }
    }

    // Given a set of symbol indexes that have already been looked up,
    // return a matching set of GeoJSONFeatures
    lookupSymbolFeatures(symbolFeatureIndexes: Array<number>,
                         serializedLayers: {[_: string]: StyleLayer},
                         bucketIndex: number,
                         sourceLayerIndex: number,
                         filterSpec: FilterSpecification,
                         filterLayerIDs: Array<string>,
                         availableImages: Array<string>,
                         styleLayers: {[_: string]: StyleLayer}) {
        const result = {};
        this.loadVTLayers();

        const filter = featureFilter(filterSpec);

        for (const symbolFeatureIndex of symbolFeatureIndexes) {
            this.loadMatchingFeature(
                result,
                bucketIndex,
                sourceLayerIndex,
                symbolFeatureIndex,
                filter,
                filterLayerIDs,
                availableImages,
                styleLayers,
                serializedLayers
            );

        }
        return result;
    }

    hasLayer(id: string) {
        for (const layerIDs of this.bucketLayerIDs) {
            for (const layerID of layerIDs) {
                if (id === layerID) return true;
            }
        }

        return false;
    }

    getId(feature: VectorTileFeature, sourceLayerId: string): string | number {
        let id: string | number = feature.id;
        if (this.promoteId) {
            const propName = typeof this.promoteId === 'string' ? this.promoteId : this.promoteId[sourceLayerId];
            id = feature.properties[propName] as string | number;
            if (typeof id === 'boolean') id = Number(id);
        }
        return id;
    }
}

register(
    'FeatureIndex',
    FeatureIndex,
    {omit: ['rawTileData', 'sourceLayerCoder']}
);

export default FeatureIndex;

function evaluateProperties(serializedProperties, styleLayerProperties, feature, featureState, availableImages) {
    return mapObject(serializedProperties, (property, key) => {
        const prop = styleLayerProperties instanceof PossiblyEvaluated ? styleLayerProperties.get(key) : null;
        return prop && prop.evaluate ? prop.evaluate(feature, featureState, availableImages) : prop;
    });
}

function getBounds(geometry: Array<Point>) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of geometry) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    return {minX, minY, maxX, maxY};
}

function topDownFeatureComparator(a, b) {
    return b - a;
}
