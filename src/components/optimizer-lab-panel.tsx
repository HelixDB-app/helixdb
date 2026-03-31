"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dbExecuteQuery, dbGetColumns } from "@/lib/db-platform";
import { useConnectionStore } from "@/stores/connection-store";
import type { ColumnInfo } from "@/lib/types";
import {
    buildAnalyzeSql,
    buildOptimizerInsights,
    buildPgStatsSql,
    buildTableStatSql,
    describeNDistinct,
    parsePgStatsRows,
    parseTableStatRow,
    pgMajorFromServerVersion,
    type OptimizerInsight,
    type PgStatsRowParsed,
    type TableStatParsed,
} from "@/lib/optimizer-lab-queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    ClipboardCopy,
    FlaskConical,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";

function insightStyles(sev: OptimizerInsight["severity"]) {
    if (sev === "risk")
        return "border-destructive/35 bg-destructive/5 [&>svg]:text-destructive";
    if (sev === "warn") return "border-amber-500/30 bg-amber-500/5 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400";
    return "border-border/40 bg-muted/20";
}

function formatTs(raw: string | null | undefined): string {
    if (raw == null || !String(raw).trim()) return "—";
    const t = Date.parse(String(raw));
    if (!Number.isFinite(t)) return String(raw).slice(0, 19);
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(t);
}

export function OptimizerLabPanel() {
    const connectionId = useConnectionStore((s) => s.connectionId);
    const serverVersion = useConnectionStore((s) => s.serverVersion);
    const schemas = useConnectionStore((s) => s.schemas);
    const tables = useConnectionStore((s) => s.tables);
    const selectedSchema = useConnectionStore((s) => s.selectedSchema);
    const selectSchema = useConnectionStore((s) => s.selectSchema);
    const selectedTableGlobal = useConnectionStore((s) => s.selectedTable);
    const seededTable = useRef(false);

    const [tablePick, setTablePick] = useState<string | null>(null);
    const [statsRows, setStatsRows] = useState<PgStatsRowParsed[]>([]);
    const [tableStat, setTableStat] = useState<TableStatParsed | null>(null);
    const [columnsMeta, setColumnsMeta] = useState<ColumnInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadMs, setLoadMs] = useState<number | null>(null);
    const [tab, setTab] = useState<"summary" | "grid">("summary");

    const includeCorrelation = useMemo(() => pgMajorFromServerVersion(serverVersion) >= 12, [serverVersion]);

    useEffect(() => {
        if (seededTable.current || !selectedTableGlobal) return;
        setTablePick(selectedTableGlobal);
        seededTable.current = true;
    }, [selectedTableGlobal]);

    const schema = selectedSchema ?? schemas[0]?.name ?? null;
    const table = tablePick;

    const loadColumns = useCallback(async () => {
        if (!connectionId || !schema || !table) {
            setColumnsMeta([]);
            return;
        }
        try {
            const cols = await dbGetColumns(connectionId, schema, table);
            setColumnsMeta(cols);
        } catch {
            setColumnsMeta([]);
        }
    }, [connectionId, schema, table]);

    const loadStats = useCallback(async () => {
        if (!connectionId || !schema || !table) {
            setStatsRows([]);
            setTableStat(null);
            setLoadMs(null);
            return;
        }
        const sqlStats = buildPgStatsSql(schema, table, includeCorrelation);
        const sqlRel = buildTableStatSql(schema, table);
        if (!sqlStats || !sqlRel) {
            setError("Invalid schema or table name.");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const [resStats, resRel] = await Promise.all([
                dbExecuteQuery(connectionId, sqlStats),
                dbExecuteQuery(connectionId, sqlRel),
            ]);
            if (resStats.is_error) {
                setError(resStats.error_message ?? "Failed to read pg_stats");
                setStatsRows([]);
                setTableStat(null);
                setLoadMs(null);
                return;
            }
            if (resRel.is_error) {
                setError(resRel.error_message ?? "Failed to read pg_stat_all_tables");
                setStatsRows([]);
                setTableStat(null);
                setLoadMs(null);
                return;
            }
            setStatsRows(parsePgStatsRows(resStats.columns, resStats.rows));
            setTableStat(parseTableStatRow(resRel.columns, resRel.rows));
            setLoadMs(resStats.execution_time_ms + resRel.execution_time_ms);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStatsRows([]);
            setTableStat(null);
            setLoadMs(null);
        } finally {
            setLoading(false);
        }
    }, [connectionId, schema, table, includeCorrelation]);

    useEffect(() => {
        void loadColumns();
    }, [loadColumns]);

    useEffect(() => {
        void loadStats();
    }, [loadStats]);

    const typeByAtt = useMemo(() => {
        const m = new Map<string, string>();
        for (const c of columnsMeta) {
            m.set(c.name, c.data_type);
        }
        return m;
    }, [columnsMeta]);

    const baseStats = useMemo(() => statsRows.filter((r) => !r.inherited), [statsRows]);

    const insights = useMemo(
        () => buildOptimizerInsights(tableStat, statsRows),
        [tableStat, statsRows]
    );

    const analyzeSql = useMemo(() => {
        if (!schema || !table) return "";
        return buildAnalyzeSql(schema, table) ?? "";
    }, [schema, table]);

    const explainShell = useMemo(() => {
        if (!schema || !table) return "";
        const qs = (s: string) => `"${s.replace(/"/g, '""')}"`;
        return `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)\nSELECT *\nFROM ${qs(schema)}.${qs(table)}\nLIMIT 100;`;
    }, [schema, table]);

    const copy = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(`Copied ${label}`);
        } catch {
            toast.error("Could not copy to clipboard");
        }
    };

    const tableOptions = useMemo(
        () =>
            tables.filter(
                (t) => schema != null && t.schema === schema && t.table_type === "BASE TABLE"
            ),
        [tables, schema]
    );

    return (
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-500/25 bg-cyan-500/10">
                            <FlaskConical className="h-4 w-4 text-cyan-300" />
                        </div>
                        <div>
                            <h1 className="text-base font-semibold tracking-tight">Optimizer Lab</h1>
                            <p className="text-xs text-muted-foreground">
                                Live <span className="font-mono text-[11px]">pg_stats</span> with planner-oriented signals —
                                diagnose bad estimates before you rewrite SQL.
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={schema ?? ""}
                        onValueChange={(v) => {
                            void selectSchema(v);
                            setTablePick(null);
                        }}
                        disabled={!schemas.length}
                    >
                        <SelectTrigger className="h-8 w-[min(100%,10rem)] text-xs" aria-label="Schema">
                            <SelectValue placeholder="Schema" />
                        </SelectTrigger>
                        <SelectContent className="z-[8500]">
                            {schemas.map((s) => (
                                <SelectItem key={s.name} value={s.name} className="text-xs font-mono">
                                    {s.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select
                        value={table ?? ""}
                        onValueChange={(v) => setTablePick(v || null)}
                        disabled={!schema || !tableOptions.length}
                    >
                        <SelectTrigger className="h-8 w-[min(100%,12rem)] text-xs" aria-label="Table">
                            <SelectValue placeholder="Table" />
                        </SelectTrigger>
                        <SelectContent className="z-[8500] max-h-64">
                            {tableOptions.map((t) => (
                                <SelectItem key={t.name} value={t.name} className="text-xs font-mono">
                                    {t.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        disabled={loading || !schema || !table}
                        onClick={() => void loadStats()}
                    >
                        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Refresh
                    </Button>
                    {loadMs != null && (
                        <Badge variant="outline" className="h-6 font-mono text-[10px] text-muted-foreground">
                            {loadMs.toFixed(0)} ms
                        </Badge>
                    )}
                </div>
            </div>

            {error && (
                <Alert variant="destructive" className="py-3">
                    <AlertTitle className="text-sm">Could not load statistics</AlertTitle>
                    <AlertDescription className="text-xs">{error}</AlertDescription>
                </Alert>
            )}

            {!table && schema && (
                <p className="text-sm text-muted-foreground">Choose a base table to inspect planner statistics.</p>
            )}

            {table && loading && !statsRows.length && !error && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-24 rounded-xl" />
                    ))}
                </div>
            )}

            {table && !loading && !error && statsRows.length === 0 && (
                <Alert className="border-border/40 bg-muted/15 py-3">
                    <AlertTitle className="text-sm">No pg_stats rows</AlertTitle>
                    <AlertDescription className="text-xs">
                        You may lack privileges, or the name may not match a visible table. Try{" "}
                        <span className="font-mono">ANALYZE</span> after large loads.
                    </AlertDescription>
                </Alert>
            )}

            {table && statsRows.length > 0 && (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Card className="border-border/35 bg-card/40 shadow-none">
                            <CardHeader className="pb-1.5 pt-3">
                                <CardTitle className="text-[11px] font-medium text-muted-foreground">
                                    Row estimate
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pb-3">
                                <p className="font-mono text-lg tabular-nums">
                                    {(tableStat?.n_live_tup ?? tableStat?.reltuples_est ?? 0).toLocaleString()}
                                </p>
                                <p className="mt-0.5 text-[10px] text-muted-foreground">
                                    live tuples · reltuples {tableStat?.reltuples_est?.toLocaleString() ?? "—"}
                                </p>
                            </CardContent>
                        </Card>
                        <Card className="border-border/35 bg-card/40 shadow-none">
                            <CardHeader className="pb-1.5 pt-3">
                                <CardTitle className="text-[11px] font-medium text-muted-foreground">
                                    Dead tuples
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pb-3">
                                <p className="font-mono text-lg tabular-nums text-amber-600/90 dark:text-amber-400/90">
                                    {(tableStat?.n_dead_tup ?? 0).toLocaleString()}
                                </p>
                                <p className="mt-0.5 text-[10px] text-muted-foreground">
                                    seq scans {tableStat?.seq_scan?.toLocaleString() ?? "—"} · idx scans{" "}
                                    {tableStat?.idx_scan?.toLocaleString() ?? "—"}
                                </p>
                            </CardContent>
                        </Card>
                        <Card className="border-border/35 bg-card/40 shadow-none">
                            <CardHeader className="pb-1.5 pt-3">
                                <CardTitle className="text-[11px] font-medium text-muted-foreground">
                                    Last ANALYZE
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pb-3">
                                <p className="text-sm font-medium leading-tight">
                                    {formatTs(tableStat?.last_autoanalyze)}
                                </p>
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                    manual: {formatTs(tableStat?.last_analyze)}
                                </p>
                            </CardContent>
                        </Card>
                        <Card className="border-border/35 bg-card/40 shadow-none">
                            <CardHeader className="pb-1.5 pt-3">
                                <CardTitle className="text-[11px] font-medium text-muted-foreground">
                                    Writes (cumulative)
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pb-3">
                                <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                                    ins {tableStat?.n_tup_ins?.toLocaleString() ?? "—"} · upd{" "}
                                    {tableStat?.n_tup_upd?.toLocaleString() ?? "—"} · del{" "}
                                    {tableStat?.n_tup_del?.toLocaleString() ?? "—"}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-1">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="h-7 gap-1 px-2 text-[10px]"
                                        disabled={!analyzeSql}
                                        onClick={() => void copy(analyzeSql, "ANALYZE")}
                                    >
                                        <ClipboardCopy className="h-3 w-3" />
                                        ANALYZE
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="h-7 gap-1 px-2 text-[10px]"
                                        disabled={!explainShell}
                                        onClick={() => void copy(explainShell, "EXPLAIN")}
                                    >
                                        <ClipboardCopy className="h-3 w-3" />
                                        EXPLAIN shell
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <Sparkles className="h-3.5 w-3.5 text-cyan-500/80" />
                            <span className="text-xs font-medium text-muted-foreground">Signals</span>
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                            {insights.map((ins, i) => (
                                <Alert
                                    key={`${ins.title}-${i}`}
                                    className={cn("py-2.5 [&>svg]:top-3", insightStyles(ins.severity))}
                                >
                                    <AlertTitle className="text-xs font-semibold leading-snug">{ins.title}</AlertTitle>
                                    <AlertDescription className="text-[11px] leading-relaxed text-muted-foreground">
                                        {ins.detail}
                                    </AlertDescription>
                                </Alert>
                            ))}
                        </div>
                    </div>

                    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                        <TabsList className="h-8 bg-muted/40 p-0.5">
                            <TabsTrigger value="summary" className="h-7 px-3 text-xs">
                                Summary
                            </TabsTrigger>
                            <TabsTrigger value="grid" className="h-7 px-3 text-xs">
                                Full grid
                            </TabsTrigger>
                        </TabsList>
                        <TabsContent value="summary" className="mt-3">
                            <ScrollArea className="h-[min(52vh,520px)] rounded-lg border border-border/30">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="hover:bg-transparent">
                                            <TableHead className="w-[1%] text-xs font-semibold">Column</TableHead>
                                            <TableHead className="text-xs font-semibold">Type</TableHead>
                                            <TableHead className="text-right text-xs font-semibold">null%</TableHead>
                                            <TableHead className="text-right text-xs font-semibold">avg width</TableHead>
                                            <TableHead className="text-xs font-semibold">distinct</TableHead>
                                            {includeCorrelation && (
                                                <TableHead className="text-right text-xs font-semibold">corr.</TableHead>
                                            )}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {baseStats.map((r) => (
                                            <TableRow key={r.attname}>
                                                <TableCell className="font-mono text-xs font-medium">{r.attname}</TableCell>
                                                <TableCell className="text-xs text-muted-foreground">
                                                    {typeByAtt.get(r.attname) ?? "—"}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs tabular-nums">
                                                    {r.null_frac != null ? `${(r.null_frac * 100).toFixed(1)}%` : "—"}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs tabular-nums">
                                                    {r.avg_width ?? "—"}
                                                </TableCell>
                                                <TableCell className="max-w-[min(40vw,14rem)] text-xs leading-snug text-muted-foreground">
                                                    {describeNDistinct(r.n_distinct)}
                                                </TableCell>
                                                {includeCorrelation && (
                                                    <TableCell className="text-right font-mono text-xs tabular-nums">
                                                        {r.correlation != null ? r.correlation.toFixed(2) : "—"}
                                                    </TableCell>
                                                )}
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                        </TabsContent>
                        <TabsContent value="grid" className="mt-3">
                            <Card className="border-border/35 bg-card/30 shadow-none">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">pg_stats projection</CardTitle>
                                    <CardDescription className="text-xs">
                                        MCV and histogram strings can be long — hover cells or copy into the query editor
                                        for deep dives.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="pt-0">
                                    <ScrollArea className="h-[min(56vh,560px)] rounded-md border border-border/25">
                                        <Table>
                                            <TableHeader>
                                                <TableRow className="hover:bg-transparent">
                                                    <TableHead className="text-xs">attname</TableHead>
                                                    <TableHead className="text-xs">inherited</TableHead>
                                                    <TableHead className="text-xs">null_frac</TableHead>
                                                    <TableHead className="text-xs">n_distinct</TableHead>
                                                    <TableHead className="min-w-[12rem] text-xs">most_common_vals</TableHead>
                                                    <TableHead className="min-w-[8rem] text-xs">most_common_freqs</TableHead>
                                                    <TableHead className="min-w-[14rem] text-xs">histogram_bounds</TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {statsRows.map((r, idx) => (
                                                    <TableRow key={`${r.attname}-${r.inherited}-${idx}`}>
                                                        <TableCell className="align-top font-mono text-[11px]">
                                                            {r.attname}
                                                        </TableCell>
                                                        <TableCell className="align-top text-[11px]">
                                                            {r.inherited ? "yes" : "no"}
                                                        </TableCell>
                                                        <TableCell className="align-top font-mono text-[11px]">
                                                            {r.null_frac ?? "—"}
                                                        </TableCell>
                                                        <TableCell className="align-top font-mono text-[11px]">
                                                            {r.n_distinct ?? "—"}
                                                        </TableCell>
                                                        <TableCell className="align-top">
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <pre className="max-h-24 max-w-[min(48vw,20rem)] cursor-default overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-muted-foreground">
                                                                        {r.most_common_vals ?? "NULL"}
                                                                    </pre>
                                                                </TooltipTrigger>
                                                                <TooltipContent
                                                                    side="left"
                                                                    className="max-w-md font-mono text-[10px]"
                                                                >
                                                                    {r.most_common_vals ?? "NULL"}
                                                                </TooltipContent>
                                                            </Tooltip>
                                                        </TableCell>
                                                        <TableCell className="align-top">
                                                            <pre className="max-h-24 max-w-[min(36vw,14rem)] overflow-auto font-mono text-[10px] text-muted-foreground">
                                                                {r.most_common_freqs ?? "NULL"}
                                                            </pre>
                                                        </TableCell>
                                                        <TableCell className="align-top">
                                                            <pre className="max-h-32 max-w-[min(56vw,28rem)] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                                                                {r.histogram_bounds ?? "NULL"}
                                                            </pre>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </ScrollArea>
                                </CardContent>
                            </Card>
                        </TabsContent>
                    </Tabs>
                </>
            )}
        </div>
    );
}
