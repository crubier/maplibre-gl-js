declare module '@mapbox/vector-tile' {
    import '@mapbox/vector-tile';
    import type Pbf from 'pbf';

    export class VectorTileLayer {
        version?: number;
        name: string;
        extent: number;
        length: number;
        feature(i: number): VectorTileFeature;
    }

    export class VectorTile {
        constructor(pbf: Pbf);
        layers: {[_: string]: VectorTileLayer};
    }

    export class VectorTileFeature {
        static types: ['Unknown', 'Point', 'LineString', 'Polygon'];
        extent: number;
        type: 1 | 2 | 3;
        id: number;
        properties: {[_: string]: string | number | boolean};
        loadGeometry(): Array<Array<Point>>;
        toGeoJSON(x: number, y: number, z: number): GeoJSON.Feature;
    }
}
