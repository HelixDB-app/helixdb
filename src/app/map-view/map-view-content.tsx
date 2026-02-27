"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    GoogleMap,
    useJsApiLoader,
    Polyline,
    Polygon,
    Marker,
    InfoWindow,
} from "@react-google-maps/api";
import html2canvas from "html2canvas";
import { useConnectionStore } from "@/stores/connection-store";
import { LeafletMapView } from "@/components/map-leaflet-view";
import { getGeometryColumns } from "@/lib/geometry";
import type { ResultColumn } from "@/lib/types";
import { dbGetColumns, dbGetTableDataGeojson } from "@/lib/tauri";
import type { QueryResult, CellValue } from "@/lib/types";
import { formatCellValue } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, Download, Loader2, MapPin, Satellite, Layers } from "lucide-react";
import { toast } from "sonner";

const LeafletMapViewDynamic = dynamic(
    () => Promise.resolve(LeafletMapView),
    { ssr: false }
);

const MAP_LIMIT = 2000;
const DEFAULT_CENTER = { lat: 20, lng: 0 };
const DEFAULT_ZOOM = 2;
const POLYLINE_STROKE = "#10b981";
const POLYLINE_HOVER_STROKE = "#34d399";
const POLYGON_FILL = "rgba(16, 185, 129, 0.15)";
const POLYGON_STROKE = "#10b981";

type GeoJSONGeometry =
    | { type: "Point"; coordinates: [number, number] }
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Polygon"; coordinates: [number, number][][] }
    | { type: "MultiPoint"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] }
    | { type: "MultiPolygon"; coordinates: [number, number][][][] };

function parseGeoJSON(value: unknown): GeoJSONGeometry | null {
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value) as { type?: string; coordinates?: unknown };
        if (parsed?.type && Array.isArray(parsed.coordinates)) return parsed as GeoJSONGeometry;
        return null;
    } catch {
        return null;
    }
}

function coordToLatLng(c: [number, number]): { lat: number; lng: number } {
    return { lat: c[1], lng: c[0] };
}

function getBoundsFromGeometries(geometries: GeoJSONGeometry[]): BoundsBox | null {
    let north = -90;
    let south = 90;
    let east = -180;
    let west = 180;
    let hasAny = false;
    const extend = (lat: number, lng: number) => {
        hasAny = true;
        if (lat > north) north = lat;
        if (lat < south) south = lat;
        if (lng > east) east = lng;
        if (lng < west) west = lng;
    };
    for (const g of geometries) {
        if (g.type === "Point") {
            extend(g.coordinates[1], g.coordinates[0]);
        } else if (g.type === "LineString") {
            g.coordinates.forEach((c) => extend(c[1], c[0]));
        } else if (g.type === "Polygon") {
            g.coordinates[0].forEach((c) => extend(c[1], c[0]));
        } else if (g.type === "MultiPoint") {
            g.coordinates.forEach((c) => extend(c[1], c[0]));
        } else if (g.type === "MultiLineString") {
            g.coordinates.flat().forEach((c) => extend(c[1], c[0]));
        } else if (g.type === "MultiPolygon") {
            g.coordinates.flat(2).forEach((c) => extend(c[1], c[0]));
        }
    }
    if (!hasAny) return null;
    return { north, south, east, west };
}

function getCellString(cell: CellValue): string | null {
    if (cell.type === "Null") return null;
    if (cell.type === "String" && typeof cell.value === "string") return cell.value;
    return formatCellValue(cell);
}

const FOCUS_ZOOM = 14;

interface BoundsBox {
    north: number;
    south: number;
    east: number;
    west: number;
}

function GoogleMapSection({
    apiKey,
    bounds,
    focusPoint,
    geometriesByRow,
    result,
    selectedRowIndex,
    setSelectedRowIndex,
    hoverRowIndex,
    setHoverRowIndex,
    setCoords,
    mapRef,
    mapType,
}: {
    apiKey: string;
    bounds: BoundsBox | null;
    focusPoint: { lat: number; lng: number } | null;
    geometriesByRow: (GeoJSONGeometry | null)[];
    result: QueryResult;
    selectedRowIndex: number | null;
    setSelectedRowIndex: (v: number | null) => void;
    hoverRowIndex: number | null;
    setHoverRowIndex: (v: number | null) => void;
    setCoords: (c: { lat: number; lng: number } | null) => void;
    mapRef: React.RefObject<google.maps.Map | null>;
    mapType: "roadmap" | "satellite" | "hybrid";
}) {
    const { isLoaded, loadError } = useJsApiLoader({
        id: "google-map-script",
        googleMapsApiKey: apiKey,
    });
    const onMapLoad = useCallback(
        (map: google.maps.Map) => {
            (mapRef as React.MutableRefObject<google.maps.Map | null>).current = map;
            if (focusPoint) {
                map.setCenter(focusPoint);
                map.setZoom(FOCUS_ZOOM);
            } else if (bounds) {
                const latLngBounds = new google.maps.LatLngBounds(
                    { lat: bounds.south, lng: bounds.west },
                    { lat: bounds.north, lng: bounds.east }
                );
                map.fitBounds(latLngBounds, 32);
            }
        },
        [bounds, focusPoint, mapRef]
    );
    const onMapUnmount = useCallback(() => {
        (mapRef as React.MutableRefObject<google.maps.Map | null>).current = null;
    }, [mapRef]);
    const onMapMouseMove = useCallback(
        (e: google.maps.MapMouseEvent) => {
            if (e.latLng) setCoords({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        },
        [setCoords]
    );
    if (loadError) {
        return (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90">
                <p className="text-sm text-destructive">Failed to load Google Maps. Check your API key.</p>
            </div>
        );
    }
    if (!isLoaded) {
        return (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            </div>
        );
    }
    return (
        <GoogleMap
            mapContainerStyle={{ width: "100%", height: "100%" }}
            center={focusPoint ?? DEFAULT_CENTER}
            zoom={focusPoint ? FOCUS_ZOOM : DEFAULT_ZOOM}
            onLoad={onMapLoad}
            onUnmount={onMapUnmount}
            onMouseMove={onMapMouseMove}
            options={{
                zoomControl: true,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                mapTypeId: mapType,
            }}
        >
            {geometriesByRow.map((geom, rowIndex) => {
                if (!geom) return null;
                const isHover = hoverRowIndex === rowIndex;
                const isSelected = selectedRowIndex === rowIndex;
                const stroke = isHover || isSelected ? POLYLINE_HOVER_STROKE : POLYLINE_STROKE;
                const strokeWeight = isHover || isSelected ? 3 : 2;
                const zIndex = isSelected ? 10 : isHover ? 5 : 1;
                if (geom.type === "Point") {
                    const pos = coordToLatLng(geom.coordinates);
                    return (
                        <Marker
                            key={rowIndex}
                            position={pos}
                            zIndex={zIndex}
                            onClick={() => setSelectedRowIndex(rowIndex)}
                            onMouseOver={() => setHoverRowIndex(rowIndex)}
                            onMouseOut={() => setHoverRowIndex(null)}
                        />
                    );
                }
                if (geom.type === "LineString") {
                    const path = geom.coordinates.map((c) => coordToLatLng(c));
                    return (
                        <Polyline
                            key={rowIndex}
                            path={path}
                            options={{ strokeColor: stroke, strokeWeight, zIndex }}
                            onClick={() => setSelectedRowIndex(rowIndex)}
                            onMouseOver={() => setHoverRowIndex(rowIndex)}
                            onMouseOut={() => setHoverRowIndex(null)}
                        />
                    );
                }
                if (geom.type === "Polygon" && geom.coordinates[0]) {
                    const path = geom.coordinates[0].map((c) => coordToLatLng(c));
                    return (
                        <Polygon
                            key={rowIndex}
                            paths={path}
                            options={{ fillColor: POLYGON_FILL, fillOpacity: 0.4, strokeColor: stroke, strokeWeight, zIndex }}
                            onClick={() => setSelectedRowIndex(rowIndex)}
                            onMouseOver={() => setHoverRowIndex(rowIndex)}
                            onMouseOut={() => setHoverRowIndex(null)}
                        />
                    );
                }
                if (geom.type === "MultiLineString") {
                    return (
                        <span key={rowIndex}>
                            {geom.coordinates.map((line, i) => {
                                const path = line.map((c) => coordToLatLng(c));
                                return (
                                    <Polyline
                                        key={`${rowIndex}-${i}`}
                                        path={path}
                                        options={{ strokeColor: stroke, strokeWeight, zIndex }}
                                        onClick={() => setSelectedRowIndex(rowIndex)}
                                        onMouseOver={() => setHoverRowIndex(rowIndex)}
                                        onMouseOut={() => setHoverRowIndex(null)}
                                    />
                                );
                            })}
                        </span>
                    );
                }
                if (geom.type === "MultiPolygon") {
                    return (
                        <span key={rowIndex}>
                            {geom.coordinates.map((poly, i) => {
                                if (!poly[0]) return null;
                                const path = poly[0].map((c) => coordToLatLng(c));
                                return (
                                    <Polygon
                                        key={`${rowIndex}-${i}`}
                                        paths={path}
                                        options={{ fillColor: POLYGON_FILL, fillOpacity: 0.4, strokeColor: stroke, strokeWeight, zIndex }}
                                        onClick={() => setSelectedRowIndex(rowIndex)}
                                        onMouseOver={() => setHoverRowIndex(rowIndex)}
                                        onMouseOut={() => setHoverRowIndex(null)}
                                    />
                                );
                            })}
                        </span>
                    );
                }
                return null;
            })}
            {hoverRowIndex != null && result && (() => {
                const g = geometriesByRow[hoverRowIndex];
                let position: { lat: number; lng: number } | undefined;
                if (g?.type === "Point") position = coordToLatLng(g.coordinates);
                else if (g?.type === "LineString" && g.coordinates[0])
                    position = coordToLatLng(g.coordinates[Math.floor(g.coordinates.length / 2)]);
                else if (g?.type === "Polygon" && g.coordinates[0]?.[0]) position = coordToLatLng(g.coordinates[0][0]);
                else if (g?.type === "MultiLineString" && g.coordinates[0]?.[0]) position = coordToLatLng(g.coordinates[0][0]);
                else if (g?.type === "MultiPolygon" && g.coordinates[0]?.[0]?.[0]) position = coordToLatLng(g.coordinates[0][0][0]);
                else if (g?.type === "MultiPoint" && g.coordinates[0]) position = coordToLatLng(g.coordinates[0]);
                if (!position) return null;
                return (
                    <InfoWindow position={position} onCloseClick={() => setHoverRowIndex(null)}>
                        <div className="text-xs text-foreground p-0.5">
                            Row {hoverRowIndex + 1}
                            {result.columns[0] && (() => {
                                const cell = result.rows[hoverRowIndex]?.[0];
                                const v = cell ? getCellString(cell) : null;
                                return v != null ? ` — ${String(v).slice(0, 30)}${String(v).length > 30 ? "…" : ""}` : "";
                            })()}
                        </div>
                    </InfoWindow>
                );
            })()}
        </GoogleMap>
    );
}

export function MapViewContent() {
    const searchParams = useSearchParams();
    const schema = searchParams.get("schema") ?? "";
    const table = searchParams.get("table") ?? "";
    const latParam = searchParams.get("lat");
    const lngParam = searchParams.get("lng");
    const focusPoint = useMemo(() => {
        if (latParam == null || lngParam == null) return null;
        const lat = parseFloat(latParam);
        const lng = parseFloat(lngParam);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
        return null;
    }, [latParam, lngParam]);
    const { connectionId, isConnected } = useConnectionStore();

    const [result, setResult] = useState<QueryResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [geometryColumnName, setGeometryColumnName] = useState<string | null>(null);
    const [mapType, setMapType] = useState<"roadmap" | "satellite" | "hybrid">("roadmap");
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
    const [hoverRowIndex, setHoverRowIndex] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);
    const mapRef = useRef<google.maps.Map | null>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);

    const apiKey = typeof process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY === "string"
        ? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
        : "";
    const hasGoogleKey = Boolean(apiKey?.trim());

    const loadData = useCallback(async () => {
        if (!connectionId || !schema || !table) return;
        setLoading(true);
        setError(null);
        try {
            const columns = await dbGetColumns(connectionId, schema, table);
            const asResultColumns: ResultColumn[] = columns.map((c) => ({
                name: c.name,
                data_type: c.data_type,
            }));
            const geomCols = getGeometryColumns(asResultColumns);
            if (geomCols.length === 0) {
                setError("No geometry columns in this table.");
                setResult(null);
                setGeometryColumnName(null);
                return;
            }
            const names = geomCols.map((c) => c.name);
            setGeometryColumnName(names[0]);
            const data = await dbGetTableDataGeojson(
                connectionId,
                schema,
                table,
                names,
                MAP_LIMIT
            );
            setResult(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load data");
            setResult(null);
            setGeometryColumnName(null);
        } finally {
            setLoading(false);
        }
    }, [connectionId, schema, table]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const geometriesByRow = useMemo(() => {
        if (!result || !geometryColumnName) return [];
        const colIdx = result.columns.findIndex((c) => c.name === geometryColumnName);
        if (colIdx < 0) return [];
        return result.rows.map((row) => {
            const cell = row[colIdx];
            const str = getCellString(cell);
            return parseGeoJSON(str ?? "");
        });
    }, [result, geometryColumnName]);

    const bounds = useMemo(() => {
        const valid = geometriesByRow.filter((g): g is GeoJSONGeometry => g != null);
        return getBoundsFromGeometries(valid);
    }, [geometriesByRow]);

    const setCoordsFromLeaflet = useCallback((lat: number, lng: number) => {
        setCoords({ lat, lng });
    }, []);

    const handleExportPng = useCallback(async () => {
        if (!mapContainerRef.current) return;
        setExporting(true);
        toast.loading("Exporting PNG…", { id: "map-export" });
        try {
            const canvas = await html2canvas(mapContainerRef.current, {
                useCORS: true,
                allowTaint: true,
                backgroundColor: "#0f172a",
            });
            canvas.toBlob(
                (blob) => {
                    if (!blob) {
                        toast.error("Export failed", { id: "map-export" });
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `map-${schema}-${table}-${Date.now()}.png`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success("Exported as PNG", { id: "map-export" });
                },
                "image/png",
                1
            );
        } catch {
            toast.error("Export failed", { id: "map-export" });
        } finally {
            setExporting(false);
        }
    }, [schema, table]);

    const handleExportSvg = useCallback(() => {
        if (!result || !geometryColumnName || !mapRef.current) return;
        const map = mapRef.current;
        const bounds = map.getBounds();
        if (!bounds) return;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const topLeft = map.getProjection()?.fromLatLngToPoint?.(sw);
        const bottomRight = map.getProjection()?.fromLatLngToPoint?.(ne);
        if (!topLeft || !bottomRight) return;
        const scale = 800 / (bottomRight.x - topLeft.x);
        const width = 800;
        const height = Math.round((bottomRight.y - topLeft.y) * scale);

        const project = (lat: number, lng: number) => {
            const point = map.getProjection()?.fromLatLngToPoint?.(
                new google.maps.LatLng(lat, lng)
            );
            if (!point) return null;
            const x = (point.x - topLeft.x) * scale;
            const y = (point.y - topLeft.y) * scale;
            return { x, y };
        };

        const paths: string[] = [];
        geometriesByRow.forEach((g) => {
            if (!g) return;
            if (g.type === "Point") {
                const p = project(g.coordinates[1], g.coordinates[0]);
                if (p) paths.push(`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${POLYLINE_STROKE}" stroke="#fff" stroke-width="1"/>`);
            } else if (g.type === "LineString") {
                const d = g.coordinates
                    .map((c) => project(c[1], c[0]))
                    .filter((p): p is { x: number; y: number } => p != null);
                if (d.length >= 2) {
                    paths.push(
                        `<path fill="none" stroke="${POLYLINE_STROKE}" stroke-width="2" d="M ${d.map((p) => `${p.x} ${p.y}`).join(" L ")}"/>`
                    );
                }
            } else if (g.type === "Polygon" && g.coordinates[0]) {
                const d = g.coordinates[0]
                    .map((c) => project(c[1], c[0]))
                    .filter((p): p is { x: number; y: number } => p != null);
                if (d.length >= 2) {
                    paths.push(
                        `<path fill="${POLYGON_FILL}" stroke="${POLYGON_STROKE}" stroke-width="2" d="M ${d.map((p) => `${p.x} ${p.y}`).join(" L ")} Z"/>`
                    );
                }
            }
        });

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <g>${paths.join("")}</g>
</svg>`;
        const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `map-${schema}-${table}-${Date.now()}.svg`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Exported as SVG", { id: "map-export" });
    }, [result, geometryColumnName, schema, table, geometriesByRow]);

    if (!isConnected || !connectionId) {
        return (
            <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-muted-foreground">
                <p>Connect to a database first.</p>
                <Button asChild variant="outline" size="sm">
                    <Link href="/">Back to app</Link>
                </Button>
            </div>
        );
    }

    if (!schema || !table) {
        return (
            <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-muted-foreground">
                <p>Missing schema or table.</p>
                <Button asChild variant="outline" size="sm">
                    <Link href="/">Back to app</Link>
                </Button>
            </div>
        );
    }

    return (
        <div className="flex h-screen flex-col bg-background">
            <header className="flex items-center justify-between gap-4 px-4 py-2 border-b border-border/20 bg-card/30 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5 text-xs">
                        <Link href="/">
                            <ArrowLeft className="h-3.5 w-3.5" />
                            Back
                        </Link>
                    </Button>
                    <span className="font-mono text-sm truncate">
                        <span className="text-muted-foreground">{schema}.</span>
                        <span className="text-foreground">{table}</span>
                        <span className="text-muted-foreground/70 ml-1">— Map</span>
                    </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {hasGoogleKey && (
                    <div className="flex rounded-lg bg-muted/40 p-0.5 border border-border/20">
                        {(["roadmap", "satellite", "hybrid"] as const).map((type) => (
                            <button
                                key={type}
                                type="button"
                                onClick={() => setMapType(type)}
                                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                    mapType === type
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {type === "roadmap" && <MapPin className="h-3 w-3" />}
                                {type === "satellite" && <Satellite className="h-3 w-3" />}
                                {type === "hybrid" && <Layers className="h-3 w-3" />}
                                {type.charAt(0).toUpperCase() + type.slice(1)}
                            </button>
                        ))}
                    </div>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 px-2.5 text-xs"
                                disabled={exporting || !result}
                            >
                                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                                Export
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={handleExportPng} className="gap-2 text-xs">
                                Download PNG
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={handleExportSvg} className="gap-2 text-xs">
                                Download SVG
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>

            <div ref={hasGoogleKey ? mapContainerRef : undefined} className="flex-1 relative min-h-0">
                {loading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
                        <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
                    </div>
                )}
                {error && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
                        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                            {error}
                        </div>
                    </div>
                )}
                {!loading && !error && result && (
                    hasGoogleKey ? (
                        <GoogleMapSection
                            apiKey={apiKey}
                            bounds={bounds}
                            focusPoint={focusPoint}
                            geometriesByRow={geometriesByRow}
                            result={result}
                            selectedRowIndex={selectedRowIndex}
                            setSelectedRowIndex={setSelectedRowIndex}
                            hoverRowIndex={hoverRowIndex}
                            setHoverRowIndex={setHoverRowIndex}
                            setCoords={setCoords}
                            mapRef={mapRef}
                            mapType={mapType}
                        />
                    ) : (
                        <LeafletMapViewDynamic
                            geometriesByRow={geometriesByRow}
                            bounds={bounds}
                            focusPoint={focusPoint}
                            selectedRowIndex={selectedRowIndex}
                            onSelectRowIndex={setSelectedRowIndex}
                            hoverRowIndex={hoverRowIndex}
                            onHoverRowIndex={setHoverRowIndex}
                            onCoords={setCoordsFromLeaflet}
                            containerRef={mapContainerRef}
                        />
                    )
                )}
                {coords != null && (
                    <div className="absolute bottom-3 left-3 px-2 py-1 rounded bg-background/90 border border-border/30 text-[10px] font-mono text-muted-foreground shadow-sm">
                        {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                    </div>
                )}
            </div>

            <Dialog open={selectedRowIndex !== null} onOpenChange={(open) => !open && setSelectedRowIndex(null)}>
                <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="text-sm font-medium">Row details</DialogTitle>
                    </DialogHeader>
                    {result && selectedRowIndex != null && result.rows[selectedRowIndex] && (
                        <ScrollArea className="flex-1 pr-2 -mx-1">
                            <dl className="grid gap-2 text-xs">
                                {result.columns.map((col, colIdx) => {
                                    const cell = result.rows[selectedRowIndex]![colIdx];
                                    const value = cell ? formatCellValue(cell) : "NULL";
                                    return (
                                        <div key={col.name} className="flex flex-col gap-0.5 border-b border-border/20 pb-2 last:border-0">
                                            <dt className="text-muted-foreground font-medium">{col.name}</dt>
                                            <dd className="font-mono text-foreground break-all">{value}</dd>
                                        </div>
                                    );
                                })}
                            </dl>
                        </ScrollArea>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
