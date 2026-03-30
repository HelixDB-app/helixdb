"use client";

import { useCallback, useEffect, useState } from "react";
import { dbListSchemas } from "@/lib/db-platform";
import type { ReplicationPublicationRow, StandbyReplicationPlan } from "@/lib/types";
import {
    replicationCreatePublication,
    replicationListPublications,
    replicationStandbyPlan,
} from "@/lib/tauri";
import {
    normalizeReplicationError,
    splitReplicationErrorForToast,
} from "@/lib/db-errors";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Copy, Loader2, Rocket, Server, Wand2 } from "lucide-react";

async function copyText(label: string, text: string) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success(`Copied ${label}`);
    } catch {
        toast.error("Copy failed");
    }
}

export interface ReplicationSetupDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connectionId: string;
    /** When true, logical publication tab is disabled (standby). */
    isStandby: boolean;
    onReplicationChanged?: () => void;
}

export function ReplicationSetupDialog({
    open,
    onOpenChange,
    connectionId,
    isStandby,
    onReplicationChanged,
}: ReplicationSetupDialogProps) {
    const [tab, setTab] = useState("logical");
    const [pubs, setPubs] = useState<ReplicationPublicationRow[]>([]);
    const [schemas, setSchemas] = useState<string[]>([]);
    const [loadBusy, setLoadBusy] = useState(false);
    const [pubName, setPubName] = useState("pgstudio_pub");
    const [mode, setMode] = useState<"allTables" | "schemas">("allTables");
    const [pickedSchemas, setPickedSchemas] = useState<Set<string>>(new Set());
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [plan, setPlan] = useState<StandbyReplicationPlan | null>(null);
    const [planBusy, setPlanBusy] = useState(false);
    const [standbyError, setStandbyError] = useState<string | null>(null);

    const refreshMeta = useCallback(async () => {
        if (!connectionId || !open) return;
        setLoadBusy(true);
        try {
            const [p, sch] = await Promise.all([
                replicationListPublications(connectionId),
                dbListSchemas(connectionId),
            ]);
            setPubs(p);
            setSchemas(sch.map((s) => s.name).filter((n) => n !== "pg_catalog" && n !== "information_schema"));
        } catch (e) {
            const { headline, detail } = splitReplicationErrorForToast(String(e));
            toast.error("Could not load publications or schemas", {
                description: [headline, detail].filter(Boolean).join("\n"),
                duration: 12_000,
            });
        } finally {
            setLoadBusy(false);
        }
    }, [connectionId, open]);

    useEffect(() => {
        if (!open) return;
        setCreateError(null);
        setStandbyError(null);
    }, [open]);

    useEffect(() => {
        if (open) void refreshMeta();
    }, [open, refreshMeta]);

    const toggleSchema = (name: string) => {
        setPickedSchemas((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const runCreatePublication = async () => {
        const trimmed = pubName.trim();
        if (!trimmed) {
            setCreateError("Enter a publication name (letters, numbers, underscores only).");
            toast.error("Invalid name", {
                description: "Publication name cannot be empty.",
            });
            return;
        }
        if (mode === "schemas" && pickedSchemas.size === 0) {
            const hint =
                "Select at least one schema, or switch to “All tables” to publish every table in the database.";
            setCreateError(hint);
            toast.error("No schema selected", { description: hint, duration: 8000 });
            return;
        }

        setCreateError(null);
        setCreateBusy(true);
        try {
            const sql = await replicationCreatePublication(connectionId, {
                name: trimmed,
                mode,
                schemas: mode === "schemas" ? Array.from(pickedSchemas) : undefined,
            });
            toast.success("Publication created", {
                description: sql.length > 120 ? `${sql.slice(0, 120)}…` : sql,
                duration: 6000,
            });
            await refreshMeta();
            onReplicationChanged?.();
        } catch (e) {
            const raw = String(e);
            const msg = normalizeReplicationError(raw);
            setCreateError(msg);
            const { headline, detail } = splitReplicationErrorForToast(raw);
            toast.error("Could not create publication", {
                description: [headline, detail].filter(Boolean).join("\n\n"),
                duration: 16_000,
            });
        } finally {
            setCreateBusy(false);
        }
    };

    const loadStandbyPlan = useCallback(async () => {
        setStandbyError(null);
        setPlanBusy(true);
        try {
            const p = await replicationStandbyPlan(connectionId);
            setPlan(p);
            toast.success("Standby snippets refreshed");
        } catch (e) {
            const raw = String(e);
            setStandbyError(normalizeReplicationError(raw));
            const { headline, detail } = splitReplicationErrorForToast(raw);
            toast.error("Could not build standby snippets", {
                description: [headline, detail].filter(Boolean).join("\n\n"),
                duration: 12_000,
            });
        } finally {
            setPlanBusy(false);
        }
    }, [connectionId]);

    useEffect(() => {
        if (!open || tab !== "physical") return;
        let cancelled = false;
        void (async () => {
            setPlanBusy(true);
            try {
                const p = await replicationStandbyPlan(connectionId);
                if (!cancelled) {
                    setPlan(p);
                    setStandbyError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    const raw = String(e);
                    setStandbyError(normalizeReplicationError(raw));
                    const { headline, detail } = splitReplicationErrorForToast(raw);
                    toast.error("Could not build standby snippets", {
                        description: [headline, detail].filter(Boolean).join("\n\n"),
                        duration: 12_000,
                    });
                }
            } finally {
                if (!cancelled) setPlanBusy(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, tab, connectionId]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[min(90vh,720px)] w-[min(96vw,560px)] gap-0 overflow-hidden border-border/40 bg-card/95 p-0 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-200">
                <DialogHeader className="border-b border-border/30 px-5 py-4">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <Rocket className="h-4 w-4 text-emerald-400" />
                        Replica setup assistant
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        Create logical replication publications on the primary, or copy tuned snippets for a
                        physical standby using{" "}
                        <code className="rounded bg-muted/60 px-1">pg_basebackup</code>.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
                    <TabsList className="mx-4 mt-3 grid h-9 w-auto grid-cols-2 rounded-lg bg-muted/40 p-1">
                        <TabsTrigger value="logical" className="text-xs" disabled={isStandby}>
                            Logical publication
                        </TabsTrigger>
                        <TabsTrigger value="physical" className="text-xs">
                            Physical standby
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="logical" className="mt-0 flex min-h-0 flex-1 flex-col px-0 pb-0 pt-0 outline-none">
                        <ScrollArea className="max-h-[min(60vh,480px)] px-4 pb-4 pt-3">
                            <div className="space-y-4 animate-in fade-in duration-200">
                            {isStandby && (
                                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
                                    Connect to the <strong>primary</strong> writer to create publications. This
                                    session is a standby.
                                </p>
                            )}

                            <div className="space-y-2">
                                <Label className="text-xs">Publication name</Label>
                                <Input
                                    className="h-9 font-mono text-xs"
                                    value={pubName}
                                    onChange={(e) => setPubName(e.target.value)}
                                    disabled={isStandby}
                                    placeholder="letters_numbers_only"
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    ASCII letters, numbers, and underscores only.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs">Scope</Label>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant={mode === "allTables" ? "default" : "outline"}
                                        className="h-8 text-xs"
                                        disabled={isStandby}
                                        onClick={() => setMode("allTables")}
                                    >
                                        All tables
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant={mode === "schemas" ? "default" : "outline"}
                                        className="h-8 gap-1 text-xs"
                                        disabled={isStandby}
                                        onClick={() => setMode("schemas")}
                                    >
                                        Schemas
                                        <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                                            PG 15+
                                        </Badge>
                                    </Button>
                                </div>
                            </div>

                            {mode === "schemas" && (
                                <div className="space-y-2 rounded-lg border border-border/30 bg-muted/15 p-3">
                                    <Label className="text-xs">Schemas to replicate</Label>
                                    <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1">
                                        {schemas.map((s) => (
                                            <label
                                                key={s}
                                                className="flex cursor-pointer items-center gap-2 text-xs"
                                            >
                                                <Checkbox
                                                    checked={pickedSchemas.has(s)}
                                                    onCheckedChange={() => toggleSchema(s)}
                                                    disabled={isStandby}
                                                />
                                                <span className="font-mono">{s}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <Button
                                type="button"
                                className="w-full"
                                disabled={isStandby || createBusy}
                                onClick={() => void runCreatePublication()}
                            >
                                {createBusy ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Creating…
                                    </>
                                ) : (
                                    <>
                                        <Wand2 className="mr-2 h-4 w-4" />
                                        Create publication
                                    </>
                                )}
                            </Button>

                            {createError && (
                                <Alert
                                    variant="destructive"
                                    className="border-red-500/40 py-2 [&>svg]:top-3"
                                >
                                    <AlertTriangle className="h-4 w-4" />
                                    <AlertTitle className="text-xs">Publication was not created</AlertTitle>
                                    <AlertDescription className="whitespace-pre-wrap text-[11px] leading-relaxed">
                                        {createError}
                                    </AlertDescription>
                                </Alert>
                            )}

                            <Separator className="bg-border/30" />

                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium">Existing publications</span>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 text-[10px]"
                                        disabled={loadBusy}
                                        onClick={() => void refreshMeta()}
                                    >
                                        Refresh
                                    </Button>
                                </div>
                                {loadBusy ? (
                                    <p className="text-xs text-muted-foreground">Loading…</p>
                                ) : pubs.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">None (or no permission).</p>
                                ) : (
                                    <ul className="space-y-1.5 text-xs">
                                        {pubs.map((p) => (
                                            <li
                                                key={p.name}
                                                className="flex flex-wrap items-center gap-2 rounded-md border border-border/25 bg-card/40 px-2 py-1.5"
                                            >
                                                <span className="font-mono font-medium">{p.name}</span>
                                                {p.allTables ? (
                                                    <Badge variant="outline" className="text-[9px]">
                                                        ALL TABLES
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="outline" className="text-[9px]">
                                                        partial
                                                    </Badge>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <div className="rounded-md border border-border/25 bg-muted/10 p-3 text-[10px] leading-relaxed text-muted-foreground">
                                <p className="font-medium text-foreground/80">Subscriber (run elsewhere)</p>
                                <p className="mt-1">
                                    On the subscriber database, create a subscription pointing at this primary,
                                    for example:
                                </p>
                                <pre className="mt-2 overflow-x-auto rounded bg-background/80 p-2 font-mono text-[9px] text-foreground/90">
                                    {`CREATE SUBSCRIPTION sub_${pubName.replace(/[^a-zA-Z0-9_]/g, "_") || "name"}
  CONNECTION 'host=PRIMARY_HOST port=5432 user=... password=... dbname=...'
  PUBLICATION ${pubName.trim() || "your_pub"}
  WITH (copy_data = true);`}
                                </pre>
                            </div>
                            </div>
                        </ScrollArea>
                    </TabsContent>

                    <TabsContent value="physical" className="mt-0 flex min-h-0 flex-1 flex-col outline-none">
                        <ScrollArea className="max-h-[min(60vh,480px)] px-4 pb-4 pt-3">
                            <div className="space-y-4 animate-in fade-in duration-200">
                            <div className="flex items-center gap-2">
                                <Server className="h-4 w-4 text-cyan-400" />
                                <p className="text-xs text-muted-foreground">
                                    Snippets use your current GUI connection (host / port / user / database).
                                    Passwords are never copied—replace{" "}
                                    <code className="rounded bg-muted/60 px-1">CHANGE_ME</code>.
                                </p>
                            </div>

                            {planBusy && !plan && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Generating snippets…
                                </div>
                            )}

                            {standbyError && (
                                <Alert variant="destructive" className="border-red-500/40 py-2 [&>svg]:top-3">
                                    <AlertTriangle className="h-4 w-4" />
                                    <AlertTitle className="text-xs">Standby template failed</AlertTitle>
                                    <AlertDescription className="whitespace-pre-wrap text-[11px] leading-relaxed">
                                        {standbyError}
                                    </AlertDescription>
                                </Alert>
                            )}

                            {plan && (
                                <div className="space-y-4">
                                    <SnippetBlock
                                        title="postgresql.auto.conf"
                                        text={plan.primaryConninfoLine}
                                        onCopy={() => void copyText("primary_conninfo", plan.primaryConninfoLine)}
                                    />
                                    <SnippetBlock
                                        title="pg_basebackup"
                                        text={plan.pgBasebackupExample}
                                        onCopy={() =>
                                            void copyText("pg_basebackup", plan.pgBasebackupExample)
                                        }
                                    />
                                    <p className="text-[10px] text-muted-foreground">{plan.standbySignalNote}</p>
                                    <ul className="list-inside list-disc space-y-1 text-[10px] text-muted-foreground">
                                        {plan.hints.map((h) => (
                                            <li key={h}>{h}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="text-xs"
                                disabled={planBusy}
                                onClick={() => void loadStandbyPlan()}
                            >
                                Regenerate snippets
                            </Button>
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>

                <DialogFooter className="border-t border-border/30 px-5 py-3">
                    <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SnippetBlock({
    title,
    text,
    onCopy,
}: {
    title: string;
    text: string;
    onCopy: () => void;
}) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{title}</span>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-[10px]"
                            onClick={onCopy}
                        >
                            <Copy className="h-3 w-3" />
                            Copy
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy to clipboard</TooltipContent>
                </Tooltip>
            </div>
            <pre
                className={cn(
                    "max-h-32 overflow-auto rounded-lg border border-border/30 bg-muted/25 p-2.5",
                    "font-mono text-[10px] leading-relaxed text-foreground/90"
                )}
            >
                {text}
            </pre>
        </div>
    );
}
