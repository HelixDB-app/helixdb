export type DateTimeMode = "date" | "time" | "timestamp" | "timestamptz";

export function getDateTimeMode(dataType: string): DateTimeMode | null {
    const t = dataType.toLowerCase().trim();
    if (t.includes("timestamp")) {
        if (t.includes("tz") || t.includes("with time zone")) return "timestamptz";
        return "timestamp";
    }
    if (t === "date") return "date";
    if (t.startsWith("time")) return "time";
    return null;
}
