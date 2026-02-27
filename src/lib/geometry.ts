import type { ResultColumn } from "@/lib/types";

/** Normalized check: column is geometry/geography (PostGIS) */
function isGeometryDataType(dataType: string): boolean {
    const lower = dataType.toLowerCase().trim();
    return lower.startsWith("geometry") || lower.startsWith("geography");
}

/** Whether a single column is geometry/geography. */
export function isGeometryColumn(col: ResultColumn): boolean {
    return isGeometryDataType(col.data_type);
}

/** Get all geometry columns from result columns. */
export function getGeometryColumns(columns: ResultColumn[]): ResultColumn[] {
    return columns.filter((col) => isGeometryDataType(col.data_type));
}

/** Whether the result has at least one geometry column. */
export function hasGeometryColumn(columns: ResultColumn[]): boolean {
    return columns.some((col) => isGeometryDataType(col.data_type));
}

/** First geometry column name, or null. */
export function getFirstGeometryColumnName(columns: ResultColumn[]): string | null {
    const geom = getGeometryColumns(columns)[0];
    return geom?.name ?? null;
}

/** Extract a single lat/lng from GeoJSON for map link (Point, or first coord of line/polygon). */
export function extractLatLngFromGeoJSON(geojson: string): { lat: number; lng: number } | null {
    try {
        const parsed = JSON.parse(geojson) as { type?: string; coordinates?: unknown };
        if (!parsed?.coordinates || !Array.isArray(parsed.coordinates)) return null;
        const c = parsed.coordinates as number[] | number[][] | number[][][];
        if (parsed.type === "Point" && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
            return { lng: c[0], lat: c[1] };
        }
        if (parsed.type === "LineString" && Array.isArray(c[0]) && c[0].length >= 2) {
            const first = c[0] as number[];
            return { lng: first[0], lat: first[1] };
        }
        if (parsed.type === "Polygon" && Array.isArray(c[0])?.[0] && (c[0] as number[][])[0].length >= 2) {
            const first = (c[0] as number[][])[0];
            return { lng: first[0], lat: first[1] };
        }
        if (parsed.type === "MultiPoint" && c.length > 0) {
            const pt = c[0] as number[];
            if (pt.length >= 2) return { lng: pt[0], lat: pt[1] };
        }
        if (parsed.type === "MultiLineString" && c.length > 0 && Array.isArray((c as number[][][])[0]?.[0])) {
            const first = (c as number[][][])[0][0];
            if (first.length >= 2) return { lng: first[0], lat: first[1] };
        }
        if (parsed.type === "MultiPolygon" && c.length > 0) {
            const poly = (c as number[][][][])[0]?.[0]?.[0];
            if (poly?.length >= 2) return { lng: poly[0], lat: poly[1] };
        }
        return null;
    } catch {
        return null;
    }
}
