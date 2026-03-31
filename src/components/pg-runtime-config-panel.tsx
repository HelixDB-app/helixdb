"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dbExecuteQuery } from "@/lib/db-platform";
import { useConnectionStore } from "@/stores/connection-store";
import {
    PG_RUNTIME_CONFIG_SQL,
    PG_RUNTIME_RECIPES,
    PG_RUNTIME_SPOTLIGHT,
    buildAlterSystemSet,
    buildResetToDefault,
    buildSessionSet,
    canSessionSetGuc,
    contextTier,
    displaySettingValue,
    parsePgSettingsResult,
    type PgRuntimeSettingRow,
} from "@/lib/pg-runtime-config";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
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
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    AlertTriangle,
    BookOpen,
    ClipboardCopy,
    Loader2,
    RefreshCw,
    Search,
    SlidersHorizontal,
    Sparkles,
} from "lucide-react";

function tierBadgeVariant(tier: ReturnType<typeof contextTier>): "default" | "secondary" | "outline" | "destructive" {
    if (tier === "restart") return "destructive";
    if (tier === "reload") return "secondary";
    if (tier === "superuser") return "outline";
    return "secondary";
}

function tierLabel(tier: ReturnType<typeof contextTier>): string {
    if (tier === "restart") return "Restart";
    if (tier === "reload") return "Reload";
    if (tier === "superuser") return "Superuser";
    return "Session";
}

export function PgRuntimeConfigPanel() {
    const connectionId = useConnectionStore((s) => s.connectionId);
    const [rows, setRows] = useState<PgRuntimeSettingRow[]>([]);
    const [loadMs, setLoadMs] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string>("__all__");
    const [spotlightId, setSpotlightId] = useState<string | null>(null);
    const [onlyNonDefault, setOnlyNonDefault] = useState(false);
    const [onlyPendingRestart, setOnlyPendingRestart] = useState(false);
    const [onlyElevatedScope, setOnlyElevatedScope] = useState(false);
    const [detail, setDetail] = useState<PgRuntimeSettingRow | null>(null);

    const load = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        setError(null);
        try {
            const res = await dbExecuteQuery(connectionId, PG_RUNTIME_CONFIG_SQL);
            if (res.is_error) {
                setError(res.error_message ?? "Failed to load pg_settings");
                setRows([]);
                setLoadMs(null);
                return;
            }
            const parsed = parsePgSettingsResult(res);
            setRows(parsed);
            setLoadMs(res.execution_time_ms);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setRows([]);
            setLoadMs(null);
        } finally {
            setLoading(false);
        }
    }, [connectionId]);

    useEffect(() => {
        void load();
    }, [load]);

    const categories = useMemo(() => {
        const s = new Set<string>();
        for (const r of rows) {
            if (r.category) s.add(r.category);
        }
        return Array.from(s).sort((a, b) => a.localeCompare(b));
    }, [rows]);

    const spotlightNames = useMemo(() => {
        if (!spotlightId) return null;
        const g = PG_RUNTIME_SPOTLIGHT.find((x) => x.id === spotlightId);
        return g ? new Set(g.names) : null;
    }, [spotlightId]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter((r) => {
            if (category !== "__all__" && r.category !== category) return false;
            if (spotlightNames && !spotlightNames.has(r.name)) return false;
            if (onlyNonDefault && r.setting === r.boot_val) return false;
            if (onlyPendingRestart && !r.pending_restart) return false;
            if (onlyElevatedScope && contextTier(r.context) === "session") return false;
            if (!q) return true;
            const blob = `${r.name} ${r.category} ${r.short_desc} ${r.setting} ${r.source}`.toLowerCase();
            return blob.includes(q);
        });
    }, [rows, category, spotlightNames, onlyNonDefault, onlyPendingRestart, onlyElevatedScope, search]);

    const pendingCount = useMemo(() => rows.filter((r) => r.pending_restart).length, [rows]);
    const nonDefaultCount = useMemo(() => rows.filter((r) => r.setting !== r.boot_val).length, [rows]);

    const copy = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(`Copied ${label}`);
        } catch {
            toast.error("Could not copy to clipboard");
        }
    };

    return (
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10">
                            <SlidersHorizontal className="h-4 w-4 text-violet-300" />
                        </div>
                        <div>
                            <h1 className="text-base font-semibold tracking-tight">Runtime Config Studio</h1>
                            <p className="text-xs text-muted-foreground">
                                Live <span className="font-mono text-[11px]">pg_settings</span> with tuning spotlights and
                                copy-ready SQL actions.
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/40 text-xs">
                                <BookOpen className="h-3.5 w-3.5 opacity-70" />
                                Session recipes
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-72">
                            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                                Paste into Query — review scope and risk first
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {PG_RUNTIME_RECIPES.map((r) => (
                                <DropdownMenuItem
                                    key={r.id}
                                    className="flex flex-col items-start gap-0.5 py-2"
                                    onClick={() => void copy(r.sql, r.title)}
                                >
                                    <span className="text-xs font-medium">{r.title}</span>
                                    <span className="text-[10px] leading-snug text-muted-foreground">{r.description}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 border-border/40 text-xs"
                        disabled={loading || !connectionId}
                        onClick={() => void load()}
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                        Refresh
                    </Button>
                </div>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/35 bg-card/40 p-3 backdrop-blur-sm">
                <Sparkles className="h-3.5 w-3.5 text-violet-400/80" />
                <span className="text-[11px] font-medium text-muted-foreground">Spotlight</span>
                <div className="flex flex-wrap gap-1.5">
                    <Button
                        type="button"
                        variant={spotlightId === null ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7 rounded-md px-2.5 text-[11px]"
                        onClick={() => setSpotlightId(null)}
                    >
                        All settings
                    </Button>
                    {PG_RUNTIME_SPOTLIGHT.map((s) => (
                        <Button
                            key={s.id}
                            type="button"
                            variant={spotlightId === s.id ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 rounded-md px-2.5 text-[11px]"
                            title={s.description}
                            onClick={() => setSpotlightId((cur) => (cur === s.id ? null : s.id))}
                        >
                            {s.label}
                        </Button>
                    ))}
                </div>
                {loadMs != null && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{loadMs.toFixed(1)} ms</span>
                )}
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search name, category, description, value, source…"
                        className="h-9 border-border/40 bg-background/50 pl-8 font-mono text-xs"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Label className="text-[11px] text-muted-foreground">Category</Label>
                        <Select value={category} onValueChange={setCategory}>
                            <SelectTrigger className="h-9 w-[min(100vw-2rem,220px)] border-border/40 text-xs">
                                <SelectValue placeholder="Category" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all__">All categories</SelectItem>
                                {categories.map((c) => (
                                    <SelectItem key={c} value={c}>
                                        {c}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap gap-4 rounded-lg border border-border/25 bg-muted/20 px-3 py-2.5">
                <div className="flex items-center gap-2">
                    <Switch id="f-nondeft" checked={onlyNonDefault} onCheckedChange={setOnlyNonDefault} />
                    <Label htmlFor="f-nondeft" className="cursor-pointer text-xs">
                        Non-default
                        <span className="ml-1 font-mono text-[10px] text-muted-foreground">({nonDefaultCount})</span>
                    </Label>
                </div>
                <div className="flex items-center gap-2">
                    <Switch id="f-pend" checked={onlyPendingRestart} onCheckedChange={setOnlyPendingRestart} />
                    <Label htmlFor="f-pend" className="cursor-pointer text-xs">
                        Pending restart
                        <span className="ml-1 font-mono text-[10px] text-muted-foreground">({pendingCount})</span>
                    </Label>
                </div>
                <div className="flex items-center gap-2">
                    <Switch id="f-scope" checked={onlyElevatedScope} onCheckedChange={setOnlyElevatedScope} />
                    <Label htmlFor="f-scope" className="cursor-pointer text-xs">
                        Reload / restart scope
                    </Label>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-border/35 bg-card/30">
                <ScrollArea className="h-[min(70vh,640px)]">
                    {loading && rows.length === 0 ? (
                        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading pg_settings…
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow className="border-border/40 hover:bg-transparent">
                                    <TableHead className="w-[28%] font-mono text-[11px]">name</TableHead>
                                    <TableHead className="font-mono text-[11px]">value</TableHead>
                                    <TableHead className="hidden lg:table-cell text-[11px]">scope</TableHead>
                                    <TableHead className="hidden md:table-cell text-[11px]">source</TableHead>
                                    <TableHead className="w-24 text-right text-[11px]"> </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map((r) => {
                                    const tier = contextTier(r.context);
                                    const changed = r.setting !== r.boot_val;
                                    return (
                                        <TableRow
                                            key={r.name}
                                            className={cn(
                                                "border-border/30 cursor-pointer",
                                                r.pending_restart && "bg-amber-500/5",
                                                changed && "bg-violet-500/[0.04]"
                                            )}
                                            onClick={() => setDetail(r)}
                                        >
                                            <TableCell className="align-top font-mono text-[11px]">
                                                <div className="flex flex-wrap items-center gap-1">
                                                    <span className="text-foreground/90">{r.name}</span>
                                                    {r.pending_restart && (
                                                        <Badge variant="outline" className="h-4 border-amber-500/40 px-1 text-[9px]">
                                                            restart
                                                        </Badge>
                                                    )}
                                                    {changed && (
                                                        <Badge variant="outline" className="h-4 border-violet-500/35 px-1 text-[9px]">
                                                            Δ boot
                                                        </Badge>
                                                    )}
                                                </div>
                                                <div className="mt-0.5 line-clamp-2 text-[10px] font-sans font-normal text-muted-foreground">
                                                    {r.short_desc}
                                                </div>
                                            </TableCell>
                                            <TableCell className="align-top font-mono text-[11px] text-emerald-200/90">
                                                {displaySettingValue(r)}
                                            </TableCell>
                                            <TableCell className="hidden align-top lg:table-cell">
                                                <Badge variant={tierBadgeVariant(tier)} className="h-5 px-1.5 text-[9px] font-normal">
                                                    {tierLabel(tier)}
                                                </Badge>
                                                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">{r.context}</div>
                                            </TableCell>
                                            <TableCell className="hidden align-top text-[10px] text-muted-foreground md:table-cell">
                                                {r.source}
                                            </TableCell>
                                            <TableCell className="text-right align-top">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-7 w-7 p-0"
                                                    title="Copy ALTER SYSTEM SET"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void copy(buildAlterSystemSet(r), "ALTER SYSTEM");
                                                    }}
                                                >
                                                    <ClipboardCopy className="h-3.5 w-3.5" />
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    )}
                </ScrollArea>
                <div className="border-t border-border/30 px-3 py-2 text-center text-[11px] text-muted-foreground">
                    Showing {filtered.length} of {rows.length} parameters
                    {spotlightId && (
                        <span className="ml-1">
                            · Spotlight: {PG_RUNTIME_SPOTLIGHT.find((s) => s.id === spotlightId)?.label}
                        </span>
                    )}
                </div>
            </div>

            <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
                <DialogContent className="max-h-[min(90vh,720px)] gap-0 overflow-hidden border-border/40 bg-card/95 p-0 sm:max-w-lg">
                    {detail && (
                        <>
                            <DialogHeader className="border-b border-border/35 px-5 py-4 text-left">
                                <DialogTitle className="font-mono text-sm tracking-tight">{detail.name}</DialogTitle>
                                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{detail.short_desc}</p>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Badge variant={tierBadgeVariant(contextTier(detail.context))} className="text-[10px]">
                                        {tierLabel(contextTier(detail.context))} · {detail.context}
                                    </Badge>
                                    <Badge variant="outline" className="font-mono text-[10px]">
                                        {detail.vartype}
                                    </Badge>
                                    <Badge variant="outline" className="text-[10px]">
                                        source: {detail.source}
                                    </Badge>
                                </div>
                            </DialogHeader>
                            <ScrollArea className="max-h-[56vh] px-5 py-4">
                                <div className="space-y-4 text-xs">
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                            Active value
                                        </div>
                                        <pre className="whitespace-pre-wrap break-all rounded-md border border-border/40 bg-muted/30 p-2 font-mono text-[11px] text-emerald-200/90">
                                            {displaySettingValue(detail)}
                                        </pre>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <div className="text-[10px] text-muted-foreground">Boot default</div>
                                            <div className="font-mono text-[11px]">{detail.boot_val || "—"}</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-muted-foreground">Reset (conf)</div>
                                            <div className="font-mono text-[11px]">{detail.reset_val || "—"}</div>
                                        </div>
                                        {(detail.min_val || detail.max_val) && (
                                            <div className="col-span-2">
                                                <div className="text-[10px] text-muted-foreground">Bounds</div>
                                                <div className="font-mono text-[11px]">
                                                    {detail.min_val || "—"} … {detail.max_val || "—"}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="space-y-2">
                                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                            SQL snippets
                                        </div>
                                        {canSessionSetGuc(detail.context) ? (
                                            <SnippetBlock
                                                label="SET (this session)"
                                                sql={buildSessionSet(detail)}
                                                onCopy={() => void copy(buildSessionSet(detail), "SET")}
                                            />
                                        ) : (
                                            <p className="text-[11px] text-muted-foreground">
                                                Session <span className="font-mono">SET</span> does not apply to this
                                                parameter — use server configuration or ALTER SYSTEM.
                                            </p>
                                        )}
                                        <SnippetBlock
                                            label="ALTER SYSTEM (superuser + reload/restart as required)"
                                            sql={buildAlterSystemSet(detail)}
                                            onCopy={() => void copy(buildAlterSystemSet(detail), "ALTER SYSTEM")}
                                        />
                                        <SnippetBlock
                                            label="Reset in postgresql.auto.conf"
                                            sql={buildResetToDefault(detail)}
                                            onCopy={() => void copy(buildResetToDefault(detail), "RESET")}
                                        />
                                    </div>
                                </div>
                            </ScrollArea>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

function SnippetBlock({
    label,
    sql,
    onCopy,
}: {
    label: string;
    sql: string;
    onCopy: () => void;
}) {
    return (
        <div className="rounded-md border border-border/35 bg-muted/20">
            <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2 py-1.5">
                <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={onCopy}>
                    <ClipboardCopy className="h-3 w-3" />
                    Copy
                </Button>
            </div>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-relaxed text-foreground/85">
                {sql}
            </pre>
        </div>
    );
}
