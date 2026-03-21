"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import type L from "leaflet";

const LeafletMapViewDynamic = dynamic(
    () => Promise.resolve(LeafletMapView),
    { ssr: false }
);

const MAP_LIMIT = 2000;
const POLYLINE_STROKE = "#0ea5e9";
const POLYGON_FILL = "rgba(14, 165, 233, 0.2)";
const POLYGON_STROKE = "#0ea5e9";

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

interface BoundsBox {
    north: number;
    south: number;
    east: number;
    west: number;
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
    const [mapType, setMapType] = useState<"roadmap" | "satellite" | "dark">("roadmap");
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
    const [hoverRowIndex, setHoverRowIndex] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);
    const leafletMapRef = useRef<L.Map | null>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);

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
        const map = leafletMapRef.current;
        if (!result || !geometryColumnName || !map) return;
        const bounds = map.getBounds();
        if (!bounds) return;
        const size = map.getSize();
        if (!size) return;
        const width = 800;
        const scale = width / size.x;
        const height = Math.round(size.y * scale);

        const project = (lat: number, lng: number) => {
            const pt = map.latLngToContainerPoint([lat, lng]);
            return { x: pt.x * scale, y: pt.y * scale };
        };

        const paths: string[] = [];
        geometriesByRow.forEach((g) => {
            if (!g) return;
            if (g.type === "Point") {
                const p = project(g.coordinates[1], g.coordinates[0]);
                paths.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="${POLYLINE_STROKE}" stroke="#fff" stroke-width="1.5"/>`);
            } else if (g.type === "LineString") {
                const d = g.coordinates.map((c) => project(c[1], c[0]));
                if (d.length >= 2) {
                    paths.push(
                        `<path fill="none" stroke="${POLYLINE_STROKE}" stroke-width="2" d="M ${d.map((p) => `${p.x} ${p.y}`).join(" L ")}"/>`
                    );
                }
            } else if (g.type === "Polygon" && g.coordinates[0]) {
                const d = g.coordinates[0].map((c) => project(c[1], c[0]));
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
        <div className="flex h-screen flex-col bg-transparent">
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
                    <div className="flex rounded-lg bg-muted/40 p-0.5 border border-border/20">
                        {(["roadmap", "satellite", "dark"] as const).map((type) => (
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
                                {type === "dark" && <Layers className="h-3 w-3" />}
                                {type.charAt(0).toUpperCase() + type.slice(1)}
                            </button>
                        ))}
                    </div>
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

            <div ref={mapContainerRef} className="flex-1 relative min-h-0">
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
                        mapType={mapType}
                        onMapReady={(map) => { leafletMapRef.current = map; }}
                    />
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
