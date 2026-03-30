"use client";

import { useId, useMemo, useState } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Line,
    LineChart,
    Pie,
    PieChart,
    ReferenceLine,
    Scatter,
    ScatterChart,
    XAxis,
    YAxis,
    ZAxis,
} from "recharts";
import type {
    PgStatStatementEntry,
    QueryHistoryDashboard,
    QueryHistoryStats,
    SlowQueryTrendRisk,
} from "@/lib/types";
import { buildPgStatAnalytics, type PgStatAnalytics } from "@/lib/query-analytics-dashboard";
import type { ChartConfig } from "@/components/ui/chart";
import {
    ChartContainer,
    ChartLegend,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
} from "@/components/ui/chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    AlertTriangle,
    BarChart3,
    Compass,
    Database,
    Flame,
    Layers,
    LayoutDashboard,
    Loader2,
    PieChart as PieChartIcon,
    Sparkles,
    Timer,
    TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CHART_BOX = "aspect-auto h-[260px] w-full sm:h-[280px]";

function formatMs(ms: number): string {
    if (!Number.isFinite(ms)) return "-";
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)}s`;
    return `${Math.round(ms)}ms`;
}

function formatNumber(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return "-";
    return value.toLocaleString();
}

function clampPreview(text: string, max = 120): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max)}…`;
}

type LocalProps = {
    variant: "local";
    dashboard: QueryHistoryDashboard | null;
    loading: boolean;
    error: string | null;
    listStats: QueryHistoryStats | null;
};

export type PgStatDashboardInputProps = {
    isConnected: boolean;
    statusLoading: boolean;
    statusError: string | null;
    statusErrorDisplay: string;
    canQuery: boolean | undefined;
    itemsLoading: boolean;
    itemsError: string | null;
    items: PgStatStatementEntry[];
    totalCount: number;
    trendRisks: SlowQueryTrendRisk[];
};

type PgStatProps = { variant: "pg_stat" } & PgStatDashboardInputProps;

export type QueryHistoryPerformanceDashboardProps = LocalProps | PgStatProps;

const localAvgConfig = {
    avg_ms: {
        label: "Avg latency",
        color: "hsl(var(--chart-1))",
    },
} satisfies ChartConfig;

const localVolumeConfig = {
    count: {
        label: "Queries",
        color: "hsl(var(--chart-2))",
    },
} satisfies ChartConfig;

const localQualityConfig = {
    error_rate: {
        label: "Error rate",
        color: "hsl(var(--chart-4))",
    },
    cache_hit_rate: {
        label: "Cache hit",
        color: "hsl(var(--chart-2))",
    },
} satisfies ChartConfig;

function KpiCard({
    title,
    value,
    hint,
    className,
}: {
    title: string;
    value: string;
    hint?: string;
    className?: string;
}) {
    return (
        <Card className={cn("border-border/50 bg-card/50 shadow-sm", className)}>
            <CardHeader className="space-y-1 pb-2">
                <CardDescription className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {title}
                </CardDescription>
                <CardTitle className="text-2xl font-semibold tabular-nums tracking-tight">{value}</CardTitle>
            </CardHeader>
            {hint ? (
                <CardContent className="pt-0">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
                </CardContent>
            ) : null}
        </Card>
    );
}

function buildTimeShareConfig(slices: PgStatAnalytics["timeShare"]): ChartConfig {
    const c: ChartConfig = {};
    slices.forEach((s, i) => {
        c[s.sliceId] = {
            label: s.name.length > 40 ? `${s.name.slice(0, 40)}…` : s.name,
            color: `hsl(var(--chart-${(i % 5) + 1}))`,
        };
    });
    return c;
}

function PgStatDashboardBody({
    analytics,
    totalCount,
    trendRisks,
}: {
    analytics: PgStatAnalytics;
    totalCount: number;
    trendRisks: SlowQueryTrendRisk[];
}) {
    const gid = useId().replace(/:/g, "");
    const [section, setSection] = useState<"overview" | "explorer">("overview");
    const { kpis } = analytics;

    const timeShareConfig = useMemo(() => buildTimeShareConfig(analytics.timeShare), [analytics.timeShare]);

    const workloadConfig = {
        totalMs: { label: "Total time", color: "hsl(var(--chart-1))" },
    } satisfies ChartConfig;

    const latencyConfig = {
        count: { label: "Statements", color: "hsl(var(--chart-2))" },
    } satisfies ChartConfig;

    const cacheConfig = {
        count: { label: "Statements", color: "hsl(var(--chart-3))" },
    } satisfies ChartConfig;

    const paretoConfig = {
        cumulativePct: { label: "Cumulative time", color: "hsl(var(--chart-1))" },
    } satisfies ChartConfig;

    const ioConfig = {
        readMs: { label: "Block read", color: "hsl(var(--chart-1))" },
        writeMs: { label: "Block write", color: "hsl(var(--chart-3))" },
    } satisfies ChartConfig;

    const scatterConfig = {
        meanMs: { label: "Mean latency", color: "hsl(var(--chart-1))" },
        calls: { label: "Calls", color: "hsl(var(--chart-2))" },
        totalMs: { label: "Total time", color: "hsl(var(--chart-4))" },
    } satisfies ChartConfig;

    const p80 = analytics.paretoP80Rank;

    return (
        <Tabs value={section} onValueChange={(v) => setSection(v as "overview" | "explorer")} className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <LayoutDashboard className="h-4 w-4" />
                        <span className="text-xs font-medium uppercase tracking-wider">Live analytics</span>
                    </div>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">pg_stat_statements</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                        Charts follow the{" "}
                        <a
                            href="https://ui.shadcn.com/charts/area"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-4 hover:underline"
                        >
                            shadcn/ui chart
                        </a>{" "}
                        pattern (theme tokens, gradients, tooltips). Data reflects the loaded list page:{" "}
                        <span className="tabular-nums font-medium text-foreground">
                            {formatNumber(kpis.statementsLoaded)} / {formatNumber(totalCount)}
                        </span>{" "}
                        statements — refine filters or scroll list to load more.
                    </p>
                </div>
                <TabsList className="grid w-full grid-cols-2 sm:w-[280px]">
                    <TabsTrigger value="overview" className="gap-1.5 text-xs">
                        <Compass className="h-3.5 w-3.5" />
                        Overview
                    </TabsTrigger>
                    <TabsTrigger value="explorer" className="gap-1.5 text-xs">
                        <BarChart3 className="h-3.5 w-3.5" />
                        Explorer
                    </TabsTrigger>
                </TabsList>
            </div>

            {p80 != null && kpis.totalExecMs > 0 ? (
                <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-card/80 to-card shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium">
                            <Sparkles className="h-4 w-4 text-primary" />
                            Quick insight
                        </CardTitle>
                        <CardDescription className="text-sm leading-relaxed text-muted-foreground">
                            Roughly <span className="font-semibold text-foreground">80%</span> of total execution time in
                            the loaded set comes from the top{" "}
                            <span className="tabular-nums font-semibold text-foreground">{p80}</span> statement
                            {p80 === 1 ? "" : "s"}. Prioritize those when tuning indexes or reducing call rate.
                        </CardDescription>
                    </CardHeader>
                </Card>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard title="Total calls (loaded)" value={formatNumber(kpis.totalCalls)} hint="Σ calls across loaded rows" />
                <KpiCard title="Total exec time" value={formatMs(kpis.totalExecMs)} hint="Σ server time for loaded statements" />
                <KpiCard title="Weighted mean latency" value={formatMs(kpis.weightedMeanMs)} hint="Σ total time ÷ Σ calls" />
                <KpiCard title="Cache hit (weighted)" value={`${kpis.weightedCacheHitPct.toFixed(1)}%`} hint="Weighted by total exec time" />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard title="Mean ≥ 1s" value={formatNumber(kpis.statementsMeanGe1s)} hint="Distinct statements" />
                <KpiCard title="Mean ≥ 100ms" value={formatNumber(kpis.statementsMeanGe100ms)} />
                <KpiCard title="Block read time" value={formatMs(kpis.totalBlkReadMs)} hint="Σ blk_read_time" />
                <KpiCard title="Block write time" value={formatMs(kpis.totalBlkWriteMs)} />
            </div>

            <TabsContent value="overview" className="mt-0 space-y-4 outline-none">
                    <div className="grid gap-4 xl:grid-cols-2">
                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm">
                            <CardHeader>
                                <CardTitle className="text-base">Cumulative time (Pareto)</CardTitle>
                                <CardDescription>
                                    Rank by total time; area shows share of workload you have covered moving down the list
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <ChartContainer config={paretoConfig} className={CHART_BOX}>
                                    <AreaChart data={analytics.pareto} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id={`pareto-${gid}`} x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="var(--color-cumulativePct)" stopOpacity={0.35} />
                                                <stop offset="95%" stopColor="var(--color-cumulativePct)" stopOpacity={0.03} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                        <XAxis
                                            dataKey="rank"
                                            tickLine={false}
                                            axisLine={false}
                                            tickMargin={8}
                                            tick={{ fontSize: 11 }}
                                            label={{ value: "Rank (by total time)", position: "insideBottom", offset: -4, fontSize: 10 }}
                                        />
                                        <YAxis
                                            tickLine={false}
                                            axisLine={false}
                                            tickMargin={8}
                                            domain={[0, 100]}
                                            tickFormatter={(v) => `${v}%`}
                                            width={44}
                                            tick={{ fontSize: 11 }}
                                        />
                                        <ChartTooltip
                                            cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                                            content={
                                                <ChartTooltipContent
                                                    indicator="line"
                                                    labelFormatter={(_, p) => {
                                                        const row = p?.[0]?.payload as { label?: string; rank?: number } | undefined;
                                                        return row?.label ? `#${row.rank} · ${row.label}` : "";
                                                    }}
                                                    formatter={(value, name) => (
                                                        <span className="font-mono tabular-nums">
                                                            {name === "cumulativePct"
                                                                ? `${Number(value).toFixed(1)}% cumulative`
                                                                : String(value ?? "")}
                                                        </span>
                                                    )}
                                                />
                                            }
                                        />
                                        <ReferenceLine
                                            y={80}
                                            stroke="hsl(var(--muted-foreground))"
                                            strokeDasharray="5 5"
                                            strokeOpacity={0.6}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="cumulativePct"
                                            stroke="var(--color-cumulativePct)"
                                            strokeWidth={2}
                                            fill={`url(#pareto-${gid})`}
                                        />
                                    </AreaChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>

                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <BarChart3 className="h-4 w-4 text-chart-1" />
                                    Top workload
                                </CardTitle>
                                <CardDescription>Total execution time by statement</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] pt-0 sm:h-[320px]">
                                <ChartContainer config={workloadConfig} className="h-full w-full">
                                    <BarChart
                                        layout="vertical"
                                        data={analytics.workloadTop}
                                        margin={{ left: 4, right: 12, top: 8, bottom: 4 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border/40" />
                                        <XAxis
                                            type="number"
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(v) => formatMs(Number(v))}
                                            tick={{ fontSize: 10 }}
                                        />
                                        <YAxis
                                            type="category"
                                            dataKey="label"
                                            width={128}
                                            tickLine={false}
                                            axisLine={false}
                                            tick={{ fontSize: 10 }}
                                        />
                                        <ChartTooltip
                                            cursor={{ fill: "hsl(var(--muted) / 0.15)" }}
                                            content={
                                                <ChartTooltipContent
                                                    formatter={(value) => (
                                                        <span className="font-mono tabular-nums">{formatMs(Number(value))}</span>
                                                    )}
                                                />
                                            }
                                        />
                                        <Bar dataKey="totalMs" fill="var(--color-totalMs)" radius={[0, 6, 6, 0]} maxBarSize={28} />
                                    </BarChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>

                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm xl:col-span-2">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <PieChartIcon className="h-4 w-4 text-chart-3" />
                                    Time share
                                </CardTitle>
                                <CardDescription>Top five statements plus other — hover for exact duration</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] pt-0">
                                <ChartContainer config={timeShareConfig} className="h-full w-full">
                                    <PieChart>
                                        <ChartTooltip
                                            content={
                                                <ChartTooltipContent
                                                    nameKey="sliceId"
                                                    formatter={(value) => (
                                                        <span className="font-mono tabular-nums">{formatMs(Number(value))}</span>
                                                    )}
                                                />
                                            }
                                        />
                                        <Pie
                                            data={analytics.timeShare}
                                            dataKey="value"
                                            nameKey="sliceId"
                                            innerRadius={52}
                                            outerRadius={88}
                                            paddingAngle={2}
                                            stroke="hsl(var(--background))"
                                            strokeWidth={1}
                                        >
                                            {analytics.timeShare.map((s) => (
                                                <Cell key={s.sliceId} fill={`var(--color-${s.sliceId})`} />
                                            ))}
                                        </Pie>
                                        <ChartLegend
                                            content={<ChartLegendContent nameKey="sliceId" className="flex-wrap gap-x-4 gap-y-1" />}
                                            verticalAlign="bottom"
                                        />
                                    </PieChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="explorer" className="mt-0 space-y-4 outline-none">
                    <div className="grid gap-4 xl:grid-cols-2">
                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm">
                            <CardHeader>
                                <CardTitle className="text-base">Mean latency distribution</CardTitle>
                                <CardDescription>Count of statements per mean-time bucket</CardDescription>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <ChartContainer config={latencyConfig} className={CHART_BOX}>
                                    <BarChart data={analytics.latencyBuckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                        <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
                                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={36} />
                                        <ChartTooltip content={<ChartTooltipContent />} />
                                        <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} maxBarSize={48} />
                                    </BarChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>

                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm">
                            <CardHeader>
                                <CardTitle className="text-base">Cache hit bands</CardTitle>
                                <CardDescription>Statements by shared_buffers hit ratio</CardDescription>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <ChartContainer config={cacheConfig} className={CHART_BOX}>
                                    <BarChart data={analytics.cacheBuckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                        <XAxis dataKey="range" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
                                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={36} />
                                        <ChartTooltip content={<ChartTooltipContent />} />
                                        <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} maxBarSize={48} />
                                    </BarChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>

                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm xl:col-span-2">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <TrendingUp className="h-4 w-4 text-chart-4" />
                                    Calls vs mean latency
                                </CardTitle>
                                <CardDescription>Bubble size reflects total time — upper-right is hot and frequent</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] pt-0">
                                <ChartContainer config={scatterConfig} className="h-full w-full">
                                    <ScatterChart margin={{ top: 12, right: 12, bottom: 12, left: 12 }}>
                                        <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                                        <XAxis type="number" dataKey="calls" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} name="Calls" />
                                        <YAxis
                                            type="number"
                                            dataKey="meanMs"
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(v) => formatMs(Number(v))}
                                            tick={{ fontSize: 11 }}
                                            width={52}
                                        />
                                        <ZAxis type="number" dataKey="totalMs" range={[48, 400]} />
                                        <ChartTooltip
                                            cursor={{ strokeDasharray: "4 4" }}
                                            content={
                                                <ChartTooltipContent
                                                    labelFormatter={(_, p) => {
                                                        const row = p?.[0]?.payload as { label?: string } | undefined;
                                                        return row?.label ?? "";
                                                    }}
                                                    formatter={(value, name) => {
                                                        if (name === "meanMs")
                                                            return <span className="font-mono">{formatMs(Number(value))}</span>;
                                                        if (name === "totalMs")
                                                            return <span className="font-mono">{formatMs(Number(value))}</span>;
                                                        return <span className="font-mono tabular-nums">{formatNumber(Number(value))}</span>;
                                                    }}
                                                />
                                            }
                                        />
                                        <Scatter data={analytics.scatter} fill="hsl(var(--chart-1) / 0.75)" />
                                    </ScatterChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>

                        <Card className="overflow-hidden border-border/60 bg-card/60 shadow-sm xl:col-span-2">
                            <CardHeader>
                                <CardTitle className="text-base">Block I/O time</CardTitle>
                                <CardDescription>Stacked read vs write time for top statements</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px] pt-0">
                                <ChartContainer config={ioConfig} className="h-full w-full">
                                    <BarChart
                                        layout="vertical"
                                        data={analytics.ioTop}
                                        margin={{ left: 4, right: 12, top: 8, bottom: 4 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border/40" />
                                        <XAxis type="number" tickFormatter={(v) => formatMs(Number(v))} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
                                        <YAxis type="category" dataKey="label" width={128} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
                                        <ChartTooltip content={<ChartTooltipContent />} />
                                        <ChartLegend content={<ChartLegendContent />} />
                                        <Bar dataKey="readMs" stackId="io" fill="var(--color-readMs)" radius={[0, 0, 0, 0]} maxBarSize={24} />
                                        <Bar dataKey="writeMs" stackId="io" fill="var(--color-writeMs)" radius={[0, 6, 6, 0]} maxBarSize={24} />
                                    </BarChart>
                                </ChartContainer>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

            <Card className="border-border/60 bg-card/60 shadow-sm">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        Snapshot trend risk
                    </CardTitle>
                    <CardDescription>
                        From local slow-query snapshots.{" "}
                        <span className="tabular-nums">
                            {analytics.riskSummary.high} high · {analytics.riskSummary.medium} medium · {analytics.riskSummary.low} low
                        </span>
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {trendRisks.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No trend rows yet. Record snapshots over time (pin statements, auto-snapshot, or ingest) to populate forecasts.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {trendRisks.slice(0, 12).map((r) => (
                                <li
                                    key={r.query_fingerprint}
                                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                                >
                                    <p className="min-w-0 flex-1 font-mono text-[11px] text-foreground/90">
                                        {clampPreview(r.query_text_preview ?? r.query_fingerprint, 100)}
                                    </p>
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "shrink-0 text-[10px]",
                                            r.risk_level === "high" && "border-red-400/50 text-red-300",
                                            r.risk_level === "medium" && "border-amber-400/50 text-amber-200",
                                            r.risk_level === "low" && "border-emerald-400/40 text-emerald-200"
                                        )}
                                    >
                                        {r.risk_level}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>
        </Tabs>
    );
}

export function QueryHistoryPerformanceDashboard(props: QueryHistoryPerformanceDashboardProps) {
    const chartUid = useId().replace(/:/g, "");

    if (props.variant === "local") {
        const { dashboard, loading, error, listStats } = props;

        if (loading) {
            return (
                <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building dashboard…
                </div>
            );
        }
        if (error) {
            return (
                <Card className="border-destructive/40 bg-destructive/10 shadow-none">
                    <CardHeader>
                        <CardTitle className="text-destructive">Failed to load dashboard</CardTitle>
                        <CardDescription className="text-destructive/90">{error}</CardDescription>
                    </CardHeader>
                </Card>
            );
        }
        if (!dashboard) {
            return <p className="text-sm text-muted-foreground">No dashboard data available.</p>;
        }

        const lastTrend = dashboard.trend[dashboard.trend.length - 1];
        const peakHour = [...dashboard.volume_by_hour].sort((a, b) => b.count - a.count)[0];

        return (
            <div className="space-y-6">
                <div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Timer className="h-4 w-4" />
                        <span className="text-xs font-medium uppercase tracking-wider">Recorded history</span>
                    </div>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">Local query analytics</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                        Area and bar charts use{" "}
                        <a
                            href="https://ui.shadcn.com/charts/area"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-4 hover:underline"
                        >
                            shadcn/ui chart
                        </a>{" "}
                        styling (gradients, semantic colors, consistent tooltips) for the selected time range and connection filter.
                    </p>
                </div>

                {listStats ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                        <KpiCard title="Queries (range)" value={formatNumber(listStats.total_queries)} />
                        <KpiCard title="Avg duration" value={formatMs(listStats.avg_time_ms)} />
                        <KpiCard title="Slowest" value={formatMs(listStats.slowest_ms)} />
                        <KpiCard title="Failed" value={formatNumber(listStats.failed_count)} />
                        <KpiCard title="Cached" value={formatNumber(listStats.cached_count)} />
                        <KpiCard title="Today" value={formatNumber(listStats.today_count)} />
                    </div>
                ) : null}

                {lastTrend ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                        <KpiCard title="Latest bucket avg" value={formatMs(lastTrend.avg_ms)} hint={new Date(lastTrend.bucket_start).toLocaleString()} />
                        <KpiCard
                            title="Error rate (latest)"
                            value={`${lastTrend.error_rate.toFixed(2)}%`}
                            hint={`${formatNumber(lastTrend.failed_count)} failed in bucket`}
                        />
                        <KpiCard
                            title="Cache hit (latest)"
                            value={`${lastTrend.cache_hit_rate.toFixed(1)}%`}
                            hint={peakHour ? `Peak hour: ${peakHour.hour}:00 (${formatNumber(peakHour.count)} queries)` : undefined}
                        />
                    </div>
                ) : null}

                <Separator className="bg-border/50" />

                <div className="grid gap-4 xl:grid-cols-2">
                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Timer className="h-4 w-4 text-chart-1" />
                                Query speed over time
                            </CardTitle>
                            <CardDescription>Mean latency by bucket</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-0">
                            <ChartContainer config={localAvgConfig} className={CHART_BOX}>
                                <AreaChart data={dashboard.trend} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id={`localAvg-${chartUid}`} x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--color-avg_ms)" stopOpacity={0.4} />
                                            <stop offset="95%" stopColor="var(--color-avg_ms)" stopOpacity={0.04} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                    <XAxis
                                        dataKey="bucket_start"
                                        tickLine={false}
                                        axisLine={false}
                                        tickMargin={8}
                                        minTickGap={24}
                                        tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                                        tick={{ fontSize: 11 }}
                                    />
                                    <YAxis tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => formatMs(Number(v))} width={48} tick={{ fontSize: 11 }} />
                                    <ChartTooltip
                                        cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                                        content={
                                            <ChartTooltipContent
                                                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                                                formatter={(value) => <span className="font-mono">{formatMs(Number(value))}</span>}
                                            />
                                        }
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="avg_ms"
                                        stroke="var(--color-avg_ms)"
                                        strokeWidth={2}
                                        fill={`url(#localAvg-${chartUid})`}
                                    />
                                </AreaChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Database className="h-4 w-4 text-chart-2" />
                                Volume by hour
                            </CardTitle>
                            <CardDescription>Query counts across the day</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-0">
                            <ChartContainer config={localVolumeConfig} className={CHART_BOX}>
                                <BarChart data={dashboard.volume_by_hour} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                    <XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
                                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={40} />
                                    <ChartTooltip content={<ChartTooltipContent />} />
                                    <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} maxBarSize={40} />
                                </BarChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Flame className="h-4 w-4 text-destructive" />
                                Top slowest groups
                            </CardTitle>
                            <CardDescription>Peak duration in the window</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {dashboard.top_slowest.map((item) => (
                                <div key={`${item.query_hash}`} className="rounded-lg border border-border/50 bg-background/40 p-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="truncate font-mono text-xs text-foreground/90">{clampPreview(item.query_text, 120)}</p>
                                        <Badge variant="outline" className="h-5 shrink-0 border-red-400/40 px-1.5 text-[10px] text-red-300">
                                            {formatMs(item.slowest_ms)}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                        Avg {formatMs(item.avg_ms)} · Runs {item.run_count.toLocaleString()}
                                    </p>
                                </div>
                            ))}
                            {dashboard.top_slowest.length === 0 && (
                                <p className="text-xs text-muted-foreground">No slow queries in selected range.</p>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Layers className="h-4 w-4 text-chart-3" />
                                Table frequency
                            </CardTitle>
                            <CardDescription>Heuristic extraction from SQL text</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {dashboard.table_frequency.map((table) => (
                                <div key={table.table_name}>
                                    <div className="mb-1 flex items-center justify-between text-xs">
                                        <span className="font-medium text-foreground/90">{table.table_name}</span>
                                        <span className="text-muted-foreground">{table.count.toLocaleString()}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-muted/40">
                                        <div
                                            className="h-2 rounded-full bg-chart-3/80"
                                            style={{
                                                width: `${Math.max(
                                                    8,
                                                    (table.count / Math.max(1, dashboard.table_frequency[0]?.count ?? 1)) * 100
                                                )}%`,
                                            }}
                                        />
                                    </div>
                                </div>
                            ))}
                            {dashboard.table_frequency.length === 0 && (
                                <p className="text-xs text-muted-foreground">No table frequency data available.</p>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm xl:col-span-2">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <AlertTriangle className="h-4 w-4 text-chart-4" />
                                Error rate & cache hit
                            </CardTitle>
                            <CardDescription>Same time buckets as latency</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-0">
                            <ChartContainer config={localQualityConfig} className="h-[260px] w-full sm:h-[280px]">
                                <AreaChart data={dashboard.trend} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id={`err-${chartUid}`} x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--color-error_rate)" stopOpacity={0.35} />
                                            <stop offset="95%" stopColor="var(--color-error_rate)" stopOpacity={0.04} />
                                        </linearGradient>
                                        <linearGradient id={`cache-${chartUid}`} x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--color-cache_hit_rate)" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="var(--color-cache_hit_rate)" stopOpacity={0.04} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                                    <XAxis
                                        dataKey="bucket_start"
                                        tickLine={false}
                                        axisLine={false}
                                        tickMargin={8}
                                        minTickGap={24}
                                        tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                                        tick={{ fontSize: 11 }}
                                    />
                                    <YAxis tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} width={40} tickFormatter={(v) => `${v}%`} />
                                    <ChartTooltip
                                        content={
                                            <ChartTooltipContent
                                                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                                                formatter={(value, name) => {
                                                    const n = Number(value ?? 0);
                                                    const label = name === "error_rate" ? "Errors" : "Cache";
                                                    return <span className="font-mono tabular-nums">{`${n.toFixed(2)}% ${label}`}</span>;
                                                }}
                                            />
                                        }
                                    />
                                    <ChartLegend content={<ChartLegendContent />} />
                                    <Area
                                        type="monotone"
                                        dataKey="error_rate"
                                        name="error_rate"
                                        stroke="var(--color-error_rate)"
                                        strokeWidth={2}
                                        fill={`url(#err-${chartUid})`}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="cache_hit_rate"
                                        name="cache_hit_rate"
                                        stroke="var(--color-cache_hit_rate)"
                                        strokeWidth={2}
                                        fill={`url(#cache-${chartUid})`}
                                    />
                                </AreaChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/60 bg-card/60 py-4 shadow-sm xl:col-span-2">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <AlertTriangle className="h-4 w-4 text-destructive" />
                                Anomaly detection
                            </CardTitle>
                            <CardDescription>Regressions vs prior window</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {dashboard.anomalies.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No major regressions detected in the current comparison window.</p>
                            ) : (
                                <div className="space-y-2">
                                    {dashboard.anomalies.map((item) => (
                                        <div key={`${item.query_hash}`} className="rounded-lg border border-destructive/25 bg-destructive/5 p-2">
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <p className="max-w-[70%] truncate font-mono text-xs text-foreground/90">{clampPreview(item.query_text, 140)}</p>
                                                <Badge variant="outline" className="h-5 border-red-400/40 px-1.5 text-[10px] text-red-300">
                                                    {item.delta_factor.toFixed(1)}× slower
                                                </Badge>
                                            </div>
                                            <p className="mt-1 text-[11px] text-muted-foreground">
                                                Previous avg {formatMs(item.previous_avg_ms)} → Recent avg {formatMs(item.recent_avg_ms)}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        );
    }

    const { variant: _omitVariant, ...pgRest } = props as PgStatProps;
    void _omitVariant;
    return <PgStatDashboardRoute {...pgRest} />;
}

function PgStatDashboardRoute(props: PgStatDashboardInputProps) {
    const analytics = useMemo(() => buildPgStatAnalytics(props.items, props.trendRisks), [props.items, props.trendRisks]);

    const {
        isConnected,
        statusLoading,
        statusError,
        statusErrorDisplay,
        canQuery,
        itemsLoading,
        itemsError,
        items,
        totalCount,
        trendRisks,
    } = props;

    if (!isConnected) {
        return (
            <Card className="border-border/50 bg-card/30 shadow-none">
                <CardContent className="flex min-h-[200px] flex-col items-center justify-center gap-2 py-10 text-center">
                    <Database className="h-10 w-10 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">Connect to a database to analyze pg_stat_statements.</p>
                </CardContent>
            </Card>
        );
    }

    if (statusLoading) {
        return (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking extension status…
            </div>
        );
    }

    if (statusError) {
        return (
            <Card className="border-destructive/40 bg-destructive/10 shadow-none">
                <CardHeader>
                    <CardTitle className="text-destructive">Could not check extension status</CardTitle>
                    <CardDescription className="whitespace-pre-wrap text-destructive/90">{statusErrorDisplay}</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    if (!canQuery) {
        return (
            <Card className="border-border/50 bg-card/30 shadow-none">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    Complete pg_stat_statements setup in list view, then return here for live analytics.
                </CardContent>
            </Card>
        );
    }

    if (itemsLoading) {
        return (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading statement statistics…
            </div>
        );
    }

    if (itemsError) {
        return (
            <Card className="border-destructive/40 bg-destructive/10 shadow-none">
                <CardHeader>
                    <CardTitle className="text-destructive">Failed to load statement stats</CardTitle>
                    <CardDescription className="text-destructive/90">{itemsError}</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    if (items.length === 0) {
        return (
            <Card className="border-border/50 bg-card/30 shadow-none">
                <CardContent className="flex min-h-[200px] flex-col items-center justify-center gap-2 py-10 text-center">
                    <BarChart3 className="h-10 w-10 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No statements matched your filters. Adjust search or filters and refresh.</p>
                </CardContent>
            </Card>
        );
    }

    return <PgStatDashboardBody analytics={analytics} totalCount={totalCount} trendRisks={trendRisks} />;
}
