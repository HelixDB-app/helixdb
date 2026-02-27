"use client";

import { useCallback, useEffect, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const POLYLINE_STROKE = "#10b981";
const POLYGON_FILL = "#10b981";
const POLYGON_STROKE = "#10b981";

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
}: LeafletMapViewProps) {
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

    const pointToLayer = useCallback((feature: GeoJSON.Feature, latlng: L.LatLngExpression) => {
        return L.circleMarker(latlng, {
            radius: 6,
            fillColor: POLYLINE_STROKE,
            color: "#fff",
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8,
        });
    }, []);

    const style = useCallback(
        (feature?: GeoJSON.Feature) => {
            const rowIndex = feature?.properties?.rowIndex as number | undefined;
            const isHighlight = rowIndex != null && (rowIndex === selectedRowIndex || rowIndex === hoverRowIndex);
            return {
                color: POLYLINE_STROKE,
                weight: isHighlight ? 3 : 2,
                fillColor: POLYGON_FILL,
                fillOpacity: 0.25,
            };
        },
        [selectedRowIndex, hoverRowIndex]
    );

    return (
        <div ref={containerRef} className="h-full w-full relative z-0 [&_.leaflet-container]:rounded-none">
            <MapContainer
                center={focusPoint ?? [20, 0]}
                zoom={focusPoint ? 14 : 2}
                className="h-full w-full"
                zoomControl={true}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitBounds bounds={bounds} focusPoint={focusPoint} />
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
