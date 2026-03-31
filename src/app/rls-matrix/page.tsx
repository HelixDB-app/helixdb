"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { APP_NAME } from "@/lib/app-config";
import { useConnectionStore } from "@/stores/connection-store";
import {
    getPoliciesForCell,
    useRlsStore,
    type PolicyCmd,
    type PolicyRow,
} from "@/stores/rls-store";
import { useAIChatStore } from "@/stores/ai-chat-store";
import { getResolvedGeminiApiKey } from "@/stores/settings-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    AlertCircle,
    ArrowLeft,
    ClipboardList,
    Copy,
    Lightbulb,
    Loader2,
    Lock,
    RefreshCw,
    Shield,
    Sparkles,
    Table2,
    Users,
    X,
} from "lucide-react";

const OPS: { op: PolicyCmd; letter: string }[] = [
    { op: "SELECT", letter: "S" },
    { op: "INSERT", letter: "I" },
    { op: "UPDATE", letter: "U" },
    { op: "DELETE", letter: "D" },
];

function roleAppliesToPolicy(policy: PolicyRow, role: string): boolean {
    const r = policy.roles;
    if (r.length === 0) return true;
    if (r.includes(role)) return true;
    return r.some((x) => x.toLowerCase() === "public");
}

function chipState(
    policies: PolicyRow[],
    rlsEnabledTables: string[],
    role: string,
    table: string,
    op: PolicyCmd,
): "off" | "ok" | "restrictive" | "denied" {
    const rlsOn = rlsEnabledTables.includes(table);
    if (!rlsOn) return "off";
    const matching = getPoliciesForCell(policies, role, table, op);
    const hasPermissive = matching.some(
        (p) => p.permissive.toUpperCase() === "PERMISSIVE",
    );
    if (hasPermissive) return "ok";
    if (matching.length > 0) return "restrictive";
    return "denied";
}

function chipClass(
    state: "off" | "ok" | "restrictive" | "denied",
    active: boolean,
): string {
    const base =
        "h-7 min-w-[1.75rem] rounded-md text-[11px] font-bold tabular-nums transition-all duration-150 hover:scale-[1.04] active:scale-[0.98]";
    const ring = active ? "ring-2 ring-violet-500 ring-offset-2 ring-offset-background" : "";
    const body =
        state === "off"
            ? "bg-muted/80 text-muted-foreground hover:bg-muted"
            : state === "ok"
              ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-500/25"
              : state === "restrictive"
                ? "bg-amber-500/15 text-amber-900 dark:text-amber-100 hover:bg-amber-500/25"
                : "bg-red-500/15 text-red-800 dark:text-red-200 hover:bg-red-500/25";
    return cn(base, body, ring);
}

function chipTooltip(
    policies: PolicyRow[],
    rlsEnabledTables: string[],
    role: string,
    table: string,
    op: PolicyCmd,
): string {
    const rlsOn = rlsEnabledTables.includes(table);
    if (!rlsOn) return "RLS not enabled on this table";
    const matching = getPoliciesForCell(policies, role, table, op);
    if (matching.length === 0) return "RLS on — no policy for this role/command (denied)";
    const names = matching.map((p) => p.policyname).join(", ");
    const perm = matching.filter((p) => p.permissive.toUpperCase() === "PERMISSIVE");
    if (perm.length > 0) return `Permissive: ${names}`;
    return `Restrictive only: ${names} (needs permissive policies too)`;
}

function OpChip({
    policies,
    rlsEnabledTables,
    role,
    table,
    op,
    letter,
    active,
    onClick,
}: {
    policies: PolicyRow[];
    rlsEnabledTables: string[];
    role: string;
    table: string;
    op: PolicyCmd;
    letter: string;
    active: boolean;
    onClick: () => void;
}) {
    const st = chipState(policies, rlsEnabledTables, role, table, op);
    const tip = chipTooltip(policies, rlsEnabledTables, role, table, op);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onClick}
                    className={chipClass(st, active)}
                >
                    {letter}
                </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-xs">
                {tip}
            </TooltipContent>
        </Tooltip>
    );
}

function MatrixGrid({
    roles,
    tables,
    policies,
    rlsEnabledTables,
    activeRole,
    activeTable,
    activeOp,
    onCellClick,
}: {
    roles: { rolname: string; rolsuper: boolean; rolcanlogin: boolean }[];
    tables: string[];
    policies: PolicyRow[];
    rlsEnabledTables: string[];
    activeRole: string | null;
    activeTable: string | null;
    activeOp: PolicyCmd | null;
    onCellClick: (role: string, table: string, op: PolicyCmd) => void;
}) {
    if (tables.length === 0) {
        return (
            <div className="rounded-xl border border-dashed border-border/50 bg-muted/20 px-6 py-16 text-center text-sm text-muted-foreground">
                No tables with policies or RLS enabled in this schema. Enable RLS or add policies to
                see the matrix.
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-border/40 bg-card/30 shadow-sm overflow-hidden">
            <ScrollArea className="w-full">
                <table className="w-max min-w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-border/40 bg-muted/30">
                            <th
                                className="sticky left-0 z-30 min-w-[10rem] bg-muted/95 backdrop-blur-sm px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shadow-[1px_0_0_0_var(--border)]"
                                scope="col"
                            >
                                Role
                            </th>
                            {tables.map((t) => (
                                <th
                                    key={t}
                                    colSpan={4}
                                    className="border-l border-border/30 px-1 py-2 text-center"
                                    scope="colgroup"
                                >
                                    <div className="flex flex-col items-center gap-0.5">
                                        <span className="font-mono text-[11px] font-semibold text-foreground">
                                            {t}
                                        </span>
                                        {rlsEnabledTables.includes(t) ? (
                                            <Badge
                                                variant="outline"
                                                className="h-4 border-emerald-500/30 px-1.5 text-[9px] text-emerald-700 dark:text-emerald-300"
                                            >
                                                RLS
                                            </Badge>
                                        ) : (
                                            <span className="text-[9px] text-muted-foreground/70">
                                                no RLS
                                            </span>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                        <tr className="border-b border-border/40 bg-muted/20">
                            <th
                                className="sticky left-0 z-30 bg-muted/95 px-3 py-1.5 text-left text-[9px] font-medium text-muted-foreground shadow-[1px_0_0_0_var(--border)]"
                                scope="col"
                            />
                            {tables.flatMap((t) =>
                                OPS.map(({ letter }) => (
                                    <th
                                        key={`${t}-${letter}`}
                                        className="w-10 min-w-[2.25rem] border-l border-border/20 px-0.5 py-1 text-center text-[9px] font-mono text-muted-foreground"
                                    >
                                        {letter}
                                    </th>
                                )),
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {roles.map((r) => (
                            <tr
                                key={r.rolname}
                                className="border-b border-border/25 transition-colors hover:bg-muted/15"
                            >
                                <td className="sticky left-0 z-20 bg-card/95 px-3 py-2 shadow-[1px_0_0_0_var(--border)] backdrop-blur-sm">
                                    <div className="font-mono text-[12px] font-medium">{r.rolname}</div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {r.rolsuper
                                            ? "superuser"
                                            : r.rolcanlogin
                                              ? "login"
                                              : "role"}
                                    </div>
                                </td>
                                {tables.flatMap((t) =>
                                    OPS.map(({ op, letter }) => (
                                        <td
                                            key={`${r.rolname}-${t}-${op}`}
                                            className="border-l border-border/20 px-1 py-1.5 text-center align-middle"
                                        >
                                            <div className="flex justify-center">
                                                <OpChip
                                                    policies={policies}
                                                    rlsEnabledTables={rlsEnabledTables}
                                                    role={r.rolname}
                                                    table={t}
                                                    op={op}
                                                    letter={letter}
                                                    active={
                                                        activeRole === r.rolname &&
                                                        activeTable === t &&
                                                        activeOp === op
                                                    }
                                                    onClick={() => onCellClick(r.rolname, t, op)}
                                                />
                                            </div>
                                        </td>
                                    )),
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
                <ScrollBar orientation="horizontal" />
            </ScrollArea>
        </div>
    );
}

function ImpersonationPane({
    schema,
    connectionId,
}: {
    schema: string;
    connectionId: string;
}) {
    const policies = useRlsStore((s) => s.policies);
    const impersonation = useRlsStore((s) => s.impersonation);
    const runProbe = useRlsStore((s) => s.runProbe);
    const setCustomSql = useRlsStore((s) => s.setCustomSql);
    const setActiveCell = useRlsStore((s) => s.setActiveCell);
    const createConversation = useAIChatStore((s) => s.createConversation);
    const setActiveConversation = useAIChatStore((s) => s.setActiveConversation);
    const sendMessage = useAIChatStore((s) => s.sendMessage);

    const { activeRole, activeTable, activeOp, result, customSql, isProbing } = impersonation;

    const cellPolicies = useMemo(() => {
        if (!activeRole || !activeTable || !activeOp) return [];
        return getPoliciesForCell(policies, activeRole, activeTable, activeOp);
    }, [policies, activeRole, activeTable, activeOp]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && activeRole) {
                setActiveCell(null, null, null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [activeRole, setActiveCell]);

    const handleAiPolicy = useCallback(() => {
        if (!activeRole || !activeTable || !activeOp) return;
        const applicable = policies.filter(
            (p) =>
                p.tablename === activeTable &&
                roleAppliesToPolicy(p, activeRole) &&
                (p.cmd.toUpperCase() === activeOp || p.cmd.toUpperCase() === "ALL"),
        );
        const lines = applicable.map(
            (p) =>
                `- ${p.policyname} (${p.permissive}) USING: ${p.qual ?? "null"} WITH CHECK: ${p.with_check ?? "null"}`,
        );
        const prompt = `PostgreSQL RLS: schema "${schema}", table "${activeTable}", role "${activeRole}", operation ${activeOp}.

Existing policies for this role/table/op:
${lines.length ? lines.join("\n") : "(none — access likely denied)"}

Suggest a correct CREATE POLICY statement (or ALTER) so this role can perform ${activeOp} appropriately. Include USING and WITH CHECK clauses where needed.`;

        const key = getResolvedGeminiApiKey();
        if (!key) {
            void navigator.clipboard.writeText(prompt);
            toast.message("No API key — prompt copied to clipboard", {
                description: "Add Gemini in Settings → AI, then paste into AI chat.",
            });
            return;
        }
        const id = createConversation();
        setActiveConversation(id);
        void sendMessage(prompt);
        toast.success("AI chat started", {
            description: "Open the AI panel from the workspace to view the draft.",
        });
    }, [
        activeRole,
        activeTable,
        activeOp,
        policies,
        schema,
        createConversation,
        setActiveConversation,
        sendMessage,
    ]);

    if (!activeRole || !activeTable || !activeOp) return null;

    const defaultProbe = `SELECT * FROM "${schema}"."${activeTable}" LIMIT 20`;

    return (
        <Card className="animate-in fade-in slide-in-from-bottom-3 duration-300 border-violet-500/20 bg-card/60 shadow-lg backdrop-blur-sm">
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-2">
                <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Shield className="h-4 w-4 text-violet-500" />
                        Impersonation probe
                    </CardTitle>
                    <CardDescription className="text-xs">
                        {activeOp} as <span className="font-mono text-foreground">{activeRole}</span> on{" "}
                        <span className="font-mono text-foreground">
                            {schema}.{activeTable}
                        </span>
                    </CardDescription>
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setActiveCell(null, null, null)}
                    aria-label="Close panel"
                >
                    <X className="h-4 w-4" />
                </Button>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
                <div className="flex min-h-[220px] flex-col gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Policies
                    </h3>
                    <ScrollArea className="max-h-64 flex-1 rounded-lg border border-border/40">
                        <div className="space-y-2 p-2">
                            {cellPolicies.length === 0 ? (
                                <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
                                    <p className="font-medium text-foreground">No policy — access denied</p>
                                    <p className="mt-1">
                                        No policy matches this role and command. Row security will block
                                        access unless bypassed.
                                    </p>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mt-3 h-8 gap-1.5 text-xs"
                                        onClick={handleAiPolicy}
                                    >
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Generate policy with AI
                                    </Button>
                                </div>
                            ) : (
                                cellPolicies.map((p) => (
                                    <div
                                        key={`${p.policyname}-${p.cmd}`}
                                        className="rounded-lg border border-border/35 bg-background/50 p-2.5 text-xs"
                                    >
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="font-medium">{p.policyname}</span>
                                            <Badge variant="secondary" className="h-5 text-[10px]">
                                                {p.cmd}
                                            </Badge>
                                            <Badge
                                                variant="outline"
                                                className={cn(
                                                    "h-5 text-[10px]",
                                                    p.permissive.toUpperCase() === "PERMISSIVE"
                                                        ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                                                        : "border-amber-500/40 text-amber-800 dark:text-amber-200",
                                                )}
                                            >
                                                {p.permissive}
                                            </Badge>
                                        </div>
                                        <p className="mt-1.5 text-[10px] text-muted-foreground">USING</p>
                                        <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
                                            {p.qual ?? "—"}
                                        </pre>
                                        {p.with_check != null && (
                                            <>
                                                <p className="mt-2 text-[10px] text-muted-foreground">
                                                    WITH CHECK
                                                </p>
                                                <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
                                                    {p.with_check}
                                                </pre>
                                            </>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </ScrollArea>
                    {cellPolicies.length > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-fit gap-1.5 text-xs text-muted-foreground"
                            onClick={handleAiPolicy}
                        >
                            <Sparkles className="h-3.5 w-3.5" />
                            Refine with AI
                        </Button>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Live probe
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                        Runs inside <span className="font-mono">BEGIN</span> …{" "}
                        <span className="font-mono">ROLLBACK</span> — never commits. Custom SQL must be a
                        single <span className="font-mono">SELECT</span> or <span className="font-mono">WITH</span>{" "}
                        statement.
                    </p>
                    <Textarea
                        value={customSql || defaultProbe}
                        onChange={(e) => setCustomSql(e.target.value)}
                        className="min-h-[100px] font-mono text-xs"
                        spellCheck={false}
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            className="h-8 gap-1.5"
                            disabled={isProbing}
                            onClick={() => runProbe(connectionId, activeRole, activeTable)}
                        >
                            {isProbing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Run as {activeRole}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5"
                            type="button"
                            onClick={() => {
                                void navigator.clipboard.writeText(customSql || defaultProbe);
                                toast.message("SQL copied");
                            }}
                        >
                            <Copy className="h-3.5 w-3.5" />
                            Copy SQL
                        </Button>
                    </div>

                    <div className="min-h-[120px] rounded-lg border border-border/40 bg-muted/10 p-3">
                        {isProbing && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Probing as {activeRole}…
                            </div>
                        )}
                        {!isProbing && result?.success && (
                            <div className="animate-in fade-in duration-200">
                                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                                    {result.row_count} row{result.row_count === 1 ? "" : "s"} visible
                                </p>
                                {result.rows.length > 0 && (
                                    <div className="mt-2 max-h-56 overflow-auto rounded-md border border-border/30">
                                        <ResultMiniTable rows={result.rows} />
                                    </div>
                                )}
                            </div>
                        )}
                        {!isProbing && result && !result.success && (
                            <div className="animate-in fade-in duration-200">
                                <p className="text-sm font-medium text-red-700 dark:text-red-300">
                                    Access denied or error
                                </p>
                                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                                    {result.error ?? "Unknown error"}
                                </pre>
                            </div>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function ResultMiniTable({ rows }: { rows: Record<string, unknown>[] }) {
    const keys = useMemo(() => {
        const first = rows[0];
        return first ? Object.keys(first) : [];
    }, [rows]);
    if (keys.length === 0) return null;
    return (
        <Table>
            <TableHeader>
                <TableRow className="hover:bg-transparent">
                    {keys.map((k) => (
                        <TableHead key={k} className="h-8 text-[10px] font-mono">
                            {k}
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row, i) => (
                    <TableRow key={i}>
                        {keys.map((k) => (
                            <TableCell key={k} className="max-w-[12rem] truncate font-mono text-[10px]">
                                {formatCell(row[k])}
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

function buildPolicyDigestMarkdown(
    schema: string,
    databaseName: string,
    policies: PolicyRow[],
    rlsEnabledTables: string[],
): string {
    const lines: string[] = [
        `# RLS digest — ${schema}`,
        ``,
        `- **Database**: ${databaseName}`,
        `- **Policies**: ${policies.length}`,
        `- **RLS-enabled tables**: ${rlsEnabledTables.length}`,
        ``,
    ];
    if (policies.length === 0) {
        lines.push(`_No policies in pg_catalog.pg_policies for this schema._`, ``);
    } else {
        lines.push(`## Policies`, ``);
        for (const p of policies) {
            lines.push(`### ${p.policyname}`);
            lines.push(`- **Table**: \`${p.schemaname}.${p.tablename}\``);
            lines.push(`- **Command**: ${p.cmd} (${p.permissive})`);
            lines.push(`- **Roles**: ${p.roles.length ? p.roles.join(", ") : "_all / public_"}`);
            lines.push(`- **USING**: \`${(p.qual ?? "—").replace(/`/g, "'")}\``);
            if (p.with_check != null) {
                lines.push(`- **WITH CHECK**: \`${p.with_check.replace(/`/g, "'")}\``);
            }
            lines.push(``);
        }
    }
    const rlsNoPol = rlsEnabledTables.filter((t) => !policies.some((p) => p.tablename === t));
    if (rlsNoPol.length) {
        lines.push(`## Tables with RLS on but no policies`, ``);
        for (const t of rlsNoPol) {
            lines.push(`- \`${schema}.${t}\` — effective deny until policies exist`);
        }
        lines.push(``);
    }
    const dormant = [
        ...new Set(policies.map((p) => p.tablename).filter((t) => !rlsEnabledTables.includes(t))),
    ].sort();
    if (dormant.length) {
        lines.push(`## Policies present but RLS not enabled on table`, ``);
        for (const t of dormant) {
            lines.push(`- \`${schema}.${t}\` — policies exist but are inactive until \`ALTER TABLE … ENABLE ROW LEVEL SECURITY\``);
        }
    }
    return lines.join("\n");
}

function computeRlsHealth(
    policies: PolicyRow[],
    rlsEnabledTables: string[],
): { rlsNoPolicies: string[]; dormantPolicyTables: string[] } {
    const rlsNoPolicies = rlsEnabledTables.filter(
        (t) => !policies.some((p) => p.tablename === t),
    );
    const dormantPolicyTables = [
        ...new Set(
            policies.map((p) => p.tablename).filter((t) => !rlsEnabledTables.includes(t)),
        ),
    ].sort((a, b) => a.localeCompare(b));
    return { rlsNoPolicies, dormantPolicyTables };
}

function RlsHealthInsights({
    schema,
    rlsNoPolicies,
    dormantPolicyTables,
}: {
    schema: string;
    rlsNoPolicies: string[];
    dormantPolicyTables: string[];
}) {
    const hasIssues = rlsNoPolicies.length > 0 || dormantPolicyTables.length > 0;
    if (!hasIssues) return null;
    return (
        <Card className="animate-in fade-in slide-in-from-top-1 duration-300 border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <Lightbulb className="h-4 w-4 text-amber-500" />
                    RLS health check
                </CardTitle>
                <CardDescription className="text-xs">
                    Automated checks on catalog data for schema{" "}
                    <span className="font-mono text-foreground">{schema}</span>
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm md:grid-cols-2">
                {rlsNoPolicies.length > 0 && (
                    <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
                        <p className="text-xs font-semibold text-destructive">RLS on, zero policies</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                            These tables deny all normal users until you add at least one permissive policy.
                        </p>
                        <ul className="mt-2 space-y-1 font-mono text-[11px]">
                            {rlsNoPolicies.map((t) => (
                                <li key={t}>
                                    {schema}.{t}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {dormantPolicyTables.length > 0 && (
                    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                            Dormant policies
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                            Policies exist in the catalog but row security is off — enable RLS for them to take
                            effect.
                        </p>
                        <ul className="mt-2 space-y-1 font-mono text-[11px]">
                            {dormantPolicyTables.map((t) => (
                                <li key={t}>
                                    {schema}.{t}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export default function RlsMatrixPage() {
    const [roleFilter, setRoleFilter] = useState("");
    const [tableFilter, setTableFilter] = useState("");

    const {
        isConnected,
        connectionId,
        disconnect,
        databaseName,
        schemas,
        selectedSchema,
        selectSchema,
    } = useConnectionStore();

    const policies = useRlsStore((s) => s.policies);
    const roles = useRlsStore((s) => s.roles);
    const rlsEnabledTables = useRlsStore((s) => s.rlsEnabledTables);
    const tables = useRlsStore((s) => s.tables);
    const selectedRlsSchema = useRlsStore((s) => s.selectedSchema);
    const isLoading = useRlsStore((s) => s.isLoading);
    const loadError = useRlsStore((s) => s.loadError);
    const impersonation = useRlsStore((s) => s.impersonation);
    const loadMatrix = useRlsStore((s) => s.loadMatrix);
    const setSchema = useRlsStore((s) => s.setSchema);
    const setActiveCell = useRlsStore((s) => s.setActiveCell);

    const schemaForSelect = selectedSchema ?? "public";
    const effectiveSchema = selectedRlsSchema || schemaForSelect;

    useEffect(() => {
        if (!connectionId || !isConnected) return;
        setSchema(schemaForSelect);
        void loadMatrix(connectionId, schemaForSelect);
    }, [connectionId, isConnected, schemaForSelect, loadMatrix, setSchema]);

    const onSchemaChange = (v: string) => {
        void selectSchema(v, connectionId ?? undefined);
        setSchema(v);
        if (connectionId) void loadMatrix(connectionId, v);
    };

    const onReload = () => {
        if (connectionId) void loadMatrix(connectionId, effectiveSchema);
    };

    const filteredRoles = useMemo(() => {
        const q = roleFilter.trim().toLowerCase();
        if (!q) return roles;
        return roles.filter((r) => r.rolname.toLowerCase().includes(q));
    }, [roles, roleFilter]);

    const filteredTables = useMemo(() => {
        const q = tableFilter.trim().toLowerCase();
        if (!q) return tables;
        return tables.filter((t) => t.toLowerCase().includes(q));
    }, [tables, tableFilter]);

    const rlsHealth = useMemo(
        () => computeRlsHealth(policies, rlsEnabledTables),
        [policies, rlsEnabledTables],
    );

    const copyPolicyDigest = useCallback(() => {
        const md = buildPolicyDigestMarkdown(
            effectiveSchema,
            databaseName ?? "connected database",
            policies,
            rlsEnabledTables,
        );
        void navigator.clipboard.writeText(md);
        toast.success("Policy digest copied", {
            description: "Markdown ready for docs, PRs, or runbooks.",
        });
    }, [effectiveSchema, databaseName, policies, rlsEnabledTables]);

    if (!isConnected || !connectionId) {
        return (
            <div className="flex h-screen items-center justify-center bg-transparent px-6">
                <div className="w-full max-w-md rounded-2xl border border-border/40 bg-card/40 p-6 text-center">
                    <Lock className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                    <h1 className="text-lg font-semibold">No active database connection</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Connect from the workspace to explore RLS policies and run impersonation probes.
                    </p>
                    <Button asChild className="mt-5">
                        <Link href="/">Back to Connections</Link>
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-transparent text-foreground">
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-28 -right-28 h-80 w-80 rounded-full bg-violet-500/5 blur-3xl" />
                <div className="absolute -bottom-32 -left-28 h-80 w-80 rounded-full bg-emerald-500/5 blur-3xl" />
            </div>

            <header className="sticky top-0 z-20 border-b border-border/35 bg-card/75 backdrop-blur-md dark:bg-background/90">
                <div className="mx-auto flex h-12 max-w-[1600px] items-center justify-between px-4">
                    <div className="flex items-center gap-3">
                        <Image
                            src="/logo.png"
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded-md object-contain"
                        />
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold bg-gradient-to-r from-violet-400 to-emerald-400 bg-clip-text text-transparent">
                                {APP_NAME}
                            </span>
                            <span className="hidden text-xs text-muted-foreground/80 sm:inline">
                                RLS policy matrix
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge
                            variant="outline"
                            className="hidden h-6 border-border/40 px-2 font-mono text-[10px] sm:inline-flex"
                        >
                            {databaseName}
                        </Badge>
                        <Button variant="ghost" size="sm" asChild className="h-7 px-2.5 text-xs">
                            <Link href="/">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Workspace
                            </Link>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => disconnect(connectionId)}
                        >
                            Disconnect
                        </Button>
                    </div>
                </div>
            </header>

            <main className="relative mx-auto max-w-[1600px] space-y-4 px-4 py-6">
                <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-card/40 p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            <Table2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Schema</span>
                            <Select value={effectiveSchema} onValueChange={onSchemaChange}>
                                <SelectTrigger className="h-8 w-[200px] font-mono text-xs">
                                    <SelectValue placeholder="Schema" />
                                </SelectTrigger>
                                <SelectContent>
                                    {(schemas.length > 0 ? schemas : [{ name: effectiveSchema }]).map(
                                        (s) => (
                                            <SelectItem
                                                key={s.name}
                                                value={s.name}
                                                className="font-mono text-xs"
                                            >
                                                {s.name}
                                            </SelectItem>
                                        ),
                                    )}
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={onReload}
                                disabled={isLoading}
                            >
                                <RefreshCw
                                    className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
                                />
                                Reload
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={copyPolicyDigest}
                                disabled={!!loadError}
                                title="Copy markdown summary for documentation or PRs"
                            >
                                <ClipboardList className="h-3.5 w-3.5" />
                                Export digest
                            </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                placeholder="Filter roles…"
                                value={roleFilter}
                                onChange={(e) => setRoleFilter(e.target.value)}
                                className="h-8 w-[140px] text-xs"
                            />
                            <Input
                                placeholder="Filter tables…"
                                value={tableFilter}
                                onChange={(e) => setTableFilter(e.target.value)}
                                className="h-8 w-[140px] text-xs"
                            />
                            <Badge variant="secondary" className="h-6 gap-1 px-2 text-[10px]">
                                <Shield className="h-3 w-3" />
                                {policies.length} policies
                            </Badge>
                            <Badge variant="secondary" className="h-6 gap-1 px-2 text-[10px]">
                                <Lock className="h-3 w-3" />
                                {rlsEnabledTables.length} RLS tables
                            </Badge>
                            <Badge variant="secondary" className="h-6 gap-1 px-2 text-[10px]">
                                <Users className="h-3 w-3" />
                                {roles.length} roles
                            </Badge>
                        </div>
                    </div>
                    <Separator className="bg-border/40" />
                    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        <span>
                            <span className="inline-block h-2.5 w-2.5 rounded bg-emerald-500/40 align-middle mr-1" />
                            Permissive policy
                        </span>
                        <span>
                            <span className="inline-block h-2.5 w-2.5 rounded bg-red-500/40 align-middle mr-1" />
                            RLS on, no matching policy
                        </span>
                        <span>
                            <span className="inline-block h-2.5 w-2.5 rounded bg-amber-500/40 align-middle mr-1" />
                            Restrictive only
                        </span>
                        <span>
                            <span className="inline-block h-2.5 w-2.5 rounded bg-muted align-middle mr-1" />
                            RLS off
                        </span>
                        <span className="text-violet-600 dark:text-violet-300">
                            Violet ring = selected cell
                        </span>
                    </div>
                </div>

                {loadError && (
                    <Alert variant="destructive" className="animate-in fade-in zoom-in-95 duration-200">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Could not load RLS metadata</AlertTitle>
                        <AlertDescription className="mt-2 space-y-3">
                            <p className="text-sm opacity-95">
                                PostgreSQL returned an error while reading{" "}
                                <code className="rounded bg-background/80 px-1 py-0.5 font-mono text-[11px]">
                                    pg_catalog.pg_policies
                                </code>
                                , roles, or table flags. Typical causes: insufficient privileges, a
                                non-PostgreSQL engine, or an older server without these catalog views.
                            </p>
                            <pre className="max-h-48 overflow-auto rounded-md border border-destructive/20 bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                                {loadError}
                            </pre>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 border-destructive/30"
                                onClick={onReload}
                            >
                                Try again
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}

                {!loadError && (
                    <RlsHealthInsights
                        schema={effectiveSchema}
                        rlsNoPolicies={rlsHealth.rlsNoPolicies}
                        dormantPolicyTables={rlsHealth.dormantPolicyTables}
                    />
                )}

                {isLoading && !policies.length && !loadError ? (
                    <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        Loading matrix…
                    </div>
                ) : !loadError ? (
                    <MatrixGrid
                        roles={filteredRoles}
                        tables={filteredTables}
                        policies={policies}
                        rlsEnabledTables={rlsEnabledTables}
                        activeRole={impersonation.activeRole}
                        activeTable={impersonation.activeTable}
                        activeOp={impersonation.activeOp}
                        onCellClick={(role, table, op) => setActiveCell(role, table, op)}
                    />
                ) : null}

                <ImpersonationPane schema={effectiveSchema} connectionId={connectionId} />

            </main>
        </div>
    );
}
