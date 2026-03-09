"use client";

import { useCallback, useEffect, useMemo } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const POLYLINE_STROKE = "#0ea5e9";
const POLYLINE_HOVER = "#38bdf8";
const POLYGON_FILL = "#0ea5e9";
const POLYGON_STROKE = "#0ea5e9";

const TILE_LAYERS: Record<"roadmap" | "satellite" | "dark", { url: string; attribution: string }> = {
    roadmap: {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    satellite: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: "&copy; Esri",
    },
    dark: {
        url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
};

function createPinIcon() {
    const size = 28;
    return L.divIcon({
        html: `<svg width="${size}" height="${size}" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z" fill="#0ea5e9" stroke="white" stroke-width="2"/>
          <circle cx="12" cy="12" r="5" fill="white"/>
        </svg>`,
        className: "!bg-transparent !border-0",
        iconSize: [size, size],
        iconAnchor: [size / 2, size],
    });
}

type GeoJSONGeometry =
    | { type: "Point"; coordinates: [number, number] }
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Polygon"; coordinates: [number, number][][] }
    | { type: "MultiPoint"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] }
    | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface BoundsBox {
    north: number;
    south: number;
    east: number;
    west: number;
}

function geomToFeature(geom: GeoJSONGeometry): GeoJSON.Feature {
    return { type: "Feature", geometry: geom as GeoJSON.Geometry, properties: {} };
}

function FitBounds({
    bounds,
    focusPoint,
}: {
    bounds: BoundsBox | null;
    focusPoint: { lat: number; lng: number } | null;
}) {
    const map = useMap();
    useEffect(() => {
        if (focusPoint) {
            map.setView([focusPoint.lat, focusPoint.lng], 14);
        } else if (bounds) {
            map.fitBounds(
                [
                    [bounds.south, bounds.west],
                    [bounds.north, bounds.east],
                ],
                { padding: [32, 32] }
            );
        }
    }, [map, bounds, focusPoint]);
    return null;
}

export interface LeafletMapViewProps {
    geometriesByRow: (GeoJSONGeometry | null)[];
    bounds: BoundsBox | null;
    focusPoint: { lat: number; lng: number } | null;
    selectedRowIndex: number | null;
    hoverRowIndex: number | null;
    onSelectRowIndex: (index: number | null) => void;
    onHoverRowIndex: (index: number | null) => void;
    onCoords: (lat: number, lng: number) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
    mapType?: "roadmap" | "satellite" | "dark";
    onMapReady?: (map: L.Map) => void;
}

export function LeafletMapView({
    geometriesByRow,
    bounds,
    focusPoint,
    selectedRowIndex,
    hoverRowIndex,
    onSelectRowIndex,
    onHoverRowIndex,
    onCoords,
    containerRef,
    mapType = "roadmap",
    onMapReady,
}: LeafletMapViewProps) {
    const tiles = useMemo(() => TILE_LAYERS[mapType], [mapType]);

    const handleEachFeature = useCallback(
        (feature: GeoJSON.Feature, layer: L.Layer) => {
            const rowIndex = feature.properties?.rowIndex as number | undefined;
            if (rowIndex == null) return;
            const path = layer as L.Path & { bindPopup?: L.Popup["bindPopup"]; openPopup?: () => void; closePopup?: () => void };
            layer.on({
                click: () => onSelectRowIndex(rowIndex),
                mouseover: () => {
                    onHoverRowIndex(rowIndex);
                    if (path.bindPopup) {
                        path.bindPopup(`Row ${rowIndex + 1}`, { closeButton: false });
                        path.openPopup?.();
                    }
                },
                mouseout: () => {
                    onHoverRowIndex(null);
                    path.closePopup?.();
                },
            });
        },
        [onSelectRowIndex, onHoverRowIndex]
    );

    const pointToLayer = useCallback((_feature: GeoJSON.Feature, latlng: L.LatLngExpression) => {
        return L.marker(latlng, { icon: createPinIcon() });
    }, []);

    const style = useCallback(
        (feature?: GeoJSON.Feature) => {
            const rowIndex = feature?.properties?.rowIndex as number | undefined;
            const isHighlight = rowIndex != null && (rowIndex === selectedRowIndex || rowIndex === hoverRowIndex);
            return {
                color: isHighlight ? POLYLINE_HOVER : POLYLINE_STROKE,
                weight: isHighlight ? 3 : 2,
                fillColor: POLYGON_FILL,
                fillOpacity: 0.28,
            };
        },
        [selectedRowIndex, hoverRowIndex]
    );

    return (
        <div ref={containerRef} className="h-full w-full relative z-0 [&_.leaflet-container]:rounded-none [&_.leaflet-control-zoom]:border-border/30 [&_.leaflet-control-attribution]:text-[10px]">
            <MapContainer
                center={focusPoint ?? [20, 0]}
                zoom={focusPoint ? 14 : 2}
                className="h-full w-full"
                zoomControl={true}
            >
                <TileLayer attribution={tiles.attribution} url={tiles.url} />
                <FitBounds bounds={bounds} focusPoint={focusPoint} />
                {onMapReady && <MapReadyCallback onMapReady={onMapReady} />}
                {geometriesByRow.map((geom, rowIndex) => {
                    if (!geom) return null;
                    const feature = geomToFeature(geom) as GeoJSON.Feature & { properties: { rowIndex: number } };
                    feature.properties = { rowIndex };
                    return (
                        <GeoJSON
                            key={rowIndex}
                            data={feature}
                            onEachFeature={handleEachFeature}
                            pointToLayer={pointToLayer}
                            style={style}
                        />
                    );
                })}
                <MapMouseHandler onCoords={onCoords} />
            </MapContainer>
        </div>
    );
}

function MapReadyCallback({ onMapReady }: { onMapReady: (map: L.Map) => void }) {
    const map = useMap();
    useEffect(() => {
        onMapReady(map);
    }, [map, onMapReady]);
    return null;
}

function MapMouseHandler({ onCoords }: { onCoords: (lat: number, lng: number) => void }) {
    const map = useMap();
    useEffect(() => {
        const handler = (e: L.LeafletMouseEvent) => {
            onCoords(e.latlng.lat, e.latlng.lng);
        };
        map.on("mousemove", handler);
        return () => {
            map.off("mousemove", handler);
        };
    }, [map, onCoords]);
    return null;
}
