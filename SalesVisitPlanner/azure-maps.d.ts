/* Azure Maps type shims — loaded at runtime via CDN, no npm dependency */
declare namespace atlas {
    enum AuthenticationType {
        subscriptionKey = "subscriptionKey"
    }

    class Map {
        constructor(container: string | HTMLElement, options: MapOptions);
        events: MapEvents;
        markers: MarkerManager;
        sources: SourceManager;
        layers: LayerManager;
        popups: PopupManager;
        setCamera(options: CameraOptions): void;
        resize(): void;
        dispose(): void;
        getCanvasContainer(): HTMLElement;
        isReady(): boolean;
    }

    interface MapOptions {
        authOptions: AuthOptions;
        center?: [number, number];
        zoom?: number;
        language?: string;
    }

    interface AuthOptions {
        authType: AuthenticationType;
        subscriptionKey: string;
    }

    interface MapEvents {
        add(eventType: "ready", callback: () => void): void;
        add(eventType: string, target: HtmlMarker, callback: () => void): void;
        add(eventType: string, target: Popup, callback: () => void): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        add(eventType: string, target: layer.BubbleLayer | layer.SymbolLayer, callback: (e: MapMouseEvent) => void): void;
        addOnce(eventType: string, callback: () => void): void;
    }

    interface MapMouseEvent {
        position?: [number, number];
        shapes?: (Shape | Record<string, unknown>)[];
    }

    class Shape {
        getProperties(): Record<string, unknown>;
    }

    interface MarkerManager {
        add(marker: HtmlMarker | HtmlMarker[]): void;
        clear(): void;
    }

    interface SourceManager {
        add(source: source.DataSource): void;
        remove(source: source.DataSource | string): void;
        getById(id: string): source.DataSource | undefined;
    }

    interface PopupManager {
        add(popup: Popup): void;
        remove(popup: Popup): void;
        clear(): void;
    }

    interface LayerManager {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        add(layer: layer.LineLayer | layer.BubbleLayer | layer.SymbolLayer | any, before?: string): void;
        remove(layerOrId: string | layer.LineLayer | layer.BubbleLayer | layer.SymbolLayer): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getLayerById(id: string): any;
    }

    interface CameraOptions {
        bounds?: data.BoundingBox;
        padding?: number | { top: number; bottom: number; left: number; right: number };
        center?: data.Position;
        zoom?: number;
        type?: string;
        duration?: number;
    }

    class Popup {
        constructor(options?: PopupOptions);
        open(map: Map): void;
        close(): void;
        setOptions(options: PopupOptions): void;
        isOpen(): boolean;
        remove(): void;
    }

    interface PopupOptions {
        content?: string | HTMLElement;
        position?: [number, number];
        pixelOffset?: [number, number];
        closeButton?: boolean;
    }

    class HtmlMarker {
        constructor(options: HtmlMarkerOptions);
        getOptions(): HtmlMarkerOptions;
    }

    interface HtmlMarkerOptions {
        position: [number, number];
        text?: string;
        color?: string;
    }

    namespace data {
        type Position = [number, number];
        type BoundingBox = [number, number, number, number];
        const BoundingBox: {
            fromPositions(positions: Position[]): BoundingBox;
        };
        class Feature {
            constructor(geometry: LineString | Point, properties?: Record<string, unknown>);
        }
        class LineString {
            constructor(coordinates: Position[]);
        }
        class Point {
            constructor(coordinates: Position);
        }
    }

    namespace source {
        class DataSource {
            constructor(id?: string);
            add(feature: data.Feature): void;
            getShapes(): Shape[];
        }
    }

    namespace layer {
        class LineLayer {
            constructor(
                source: source.DataSource,
                id: string | null,
                options?: LineLayerOptions
            );
        }
        interface LineLayerOptions {
            strokeColor?: string;
            strokeWidth?: number;
            strokeDashArray?: number[];
        }
        class BubbleLayer {
            constructor(
                source: source.DataSource,
                id: string | null,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                options?: any
            );
        }
        class SymbolLayer {
            constructor(
                source: source.DataSource,
                id: string | null,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                options?: any
            );
        }
    }
}

/* Azure Maps Search API response shape */
interface AzureMapsSearchResponse {
    results: AzureMapsSearchResult[];
}

interface AzureMapsSearchResult {
    position: {
        lat: number;
        lon: number;
    };
}
