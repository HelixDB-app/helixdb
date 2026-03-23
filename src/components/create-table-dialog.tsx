"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dbCreateTable } from "@/lib/db-platform";
import type { CreateColumnDef } from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import {
    Plus,
    Trash2,
    ChevronUp,
    ChevronDown,
    Key,
    AlertCircle,
    CheckCircle2,
    Loader2,
    Table2,
    Code2,
    Columns,
    ShieldCheck,
    Copy,
    Check,
    X,
    GripVertical,
    Sparkles,
    Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColumnRow extends CreateColumnDef {
    _id: string; // internal React key
}

interface ValidationError {
    field: string;
    message: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Core PostgreSQL built-in types suitable for CREATE TABLE (excludes pseudotypes like anyelement). */
const PG_TYPES = [
    {
        group: "Integer",
        types: ["smallint", "integer", "bigint", "smallserial", "serial", "bigserial"],
    },
    {
        group: "Floating point",
        types: ["real", "double precision", "numeric", "decimal", "money"],
    },
    { group: "Text", types: ["text", "varchar", "char", "name"] },
    { group: "Boolean", types: ["boolean"] },
    {
        group: "Date / time",
        types: ["date", "time", "timetz", "timestamp", "timestamptz", "interval"],
    },
    { group: "UUID", types: ["uuid"] },
    // jsonb first: better default for indexed / queried JSON in PostgreSQL
    { group: "JSON", types: ["jsonb", "json"] },
    { group: "Binary", types: ["bytea"] },
    { group: "Bit string", types: ["bit", "varbit"] },
    { group: "Network", types: ["inet", "cidr", "macaddr", "macaddr8"] },
    {
        group: "Geometric",
        types: ["point", "line", "lseg", "box", "path", "polygon", "circle"],
    },
    {
        group: "Range",
        types: ["int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange"],
    },
    { group: "Full-text search", types: ["tsvector", "tsquery"] },
    { group: "XML", types: ["xml"] },
    {
        group: "Other / system",
        types: ["oid", "xid", "cid", "tid", "pg_lsn"],
    },
];

const ALL_TYPES = PG_TYPES.flatMap((g) => g.types);

/** Types where Len is commonly used (precision, max length, or bit length). */
const LENGTH_TYPES = new Set([
    "varchar",
    "char",
    "numeric",
    "decimal",
    "bit",
    "varbit",
    "time",
    "timetz",
    "timestamp",
    "timestamptz",
    "interval",
]);

function makeDefaultColumn(idx: number): ColumnRow {
    return {
        _id: `col-${Date.now()}-${idx}`,
        name: "",
        data_type: "text",
        length: null,
        is_nullable: true,
        default_value: null,
        is_primary_key: false,
        is_unique: false,
        check_constraint: null,
    };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateIdentifier(name: string): string | null {
    if (!name.trim()) return "Required";
    if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name.trim())) {
        return "Must start with a letter or underscore and contain only letters, digits, underscores, or $";
    }
    if (name.length > 63) return "Max 63 characters";
    return null;
}

function validateAll(
    tableName: string,
    schema: string,
    columns: ColumnRow[]
): ValidationError[] {
    const errors: ValidationError[] = [];

    const tableErr = validateIdentifier(tableName);
    if (tableErr) errors.push({ field: "table_name", message: `Table name: ${tableErr}` });

    if (!schema.trim()) errors.push({ field: "schema", message: "Schema is required" });

    if (columns.length === 0) {
        errors.push({ field: "columns", message: "Add at least one column" });
    }

    const names = new Set<string>();
    columns.forEach((col, i) => {
        const nameErr = validateIdentifier(col.name);
        if (nameErr) {
            errors.push({ field: `col_name_${i}`, message: `Column ${i + 1} name: ${nameErr}` });
        } else {
            const lower = col.name.toLowerCase();
            if (names.has(lower)) {
                errors.push({ field: `col_dup_${i}`, message: `Duplicate column name: "${col.name}"` });
            }
            names.add(lower);
        }

        if (!col.data_type.trim()) {
            errors.push({ field: `col_type_${i}`, message: `Column "${col.name || i + 1}": type is required` });
        }

        // PK should not be nullable
        if (col.is_primary_key && col.is_nullable) {
            errors.push({
                field: `col_pk_null_${i}`,
                message: `Column "${col.name || i + 1}": primary key columns should be NOT NULL`,
            });
        }
    });

    return errors;
}

// ─── SQL Preview ──────────────────────────────────────────────────────────────

function buildSqlPreview(
    tableName: string,
    schema: string,
    columns: ColumnRow[],
    ifNotExists: boolean
): string {
    if (!tableName || columns.length === 0) {
        return "-- Fill in table name and add columns to see the SQL preview";
    }

    const safeSchema = schema || "public";
    const notExists = ifNotExists ? " IF NOT EXISTS" : "";

    const pkCols = columns.filter((c) => c.is_primary_key);

    const colLines: string[] = columns.map((col) => {
        const typeStr = col.length
            ? `${col.data_type}(${col.length})`
            : col.data_type;

        const nullPart = col.is_nullable ? "" : " NOT NULL";
        const defPart = col.default_value ? ` DEFAULT ${col.default_value}` : "";
        const pkPart = pkCols.length === 1 && col.is_primary_key ? " PRIMARY KEY" : "";

        return `  "${col.name || "??"}" ${typeStr}${nullPart}${defPart}${pkPart}`;
    });

    const constraintLines: string[] = [];

    if (pkCols.length > 1) {
        constraintLines.push(`  PRIMARY KEY (${pkCols.map((c) => `"${c.name}"`).join(", ")})`);
    }

    columns.forEach((col) => {
        if (col.is_unique && !(pkCols.length === 1 && col.is_primary_key)) {
            constraintLines.push(`  UNIQUE ("${col.name}")`);
        }
        if (col.check_constraint?.trim()) {
            constraintLines.push(`  CHECK (${col.check_constraint.trim()})`);
        }
    });

    const allLines = [...colLines, ...constraintLines];

    return `CREATE TABLE${notExists} "${safeSchema}"."${tableName}" (\n${allLines.join(",\n")}\n);`;
}

/** Result of parsing CREATE TABLE SQL for syncing into the column editor */
export interface ParsedCreateTable {
    schema: string;
    tableName: string;
    ifNotExists: boolean;
    columns: Omit<ColumnRow, "_id">[];
}

/**
 * Parse a CREATE TABLE statement and extract schema, table name, if not exists, and column definitions.
 * Used when switching from Edit SQL back to the Columns tab. Returns null on parse failure.
 */
function parseCreateTableSql(sql: string): ParsedCreateTable | null {
    const trimmed = sql.trim();
    if (!trimmed.toUpperCase().startsWith("CREATE TABLE")) return null;

    const rest = trimmed.slice(12).trimStart();
    const ifNotExists = rest.toUpperCase().startsWith("IF NOT EXISTS");
    const afterExists = (ifNotExists ? rest.slice(13) : rest).trimStart();

    // Match "schema"."table" or "table"
    const quotedNameMatch = afterExists.match(/^"([^"]*)"\s*\.\s*"([^"]+)"\s*\(/);
    let schema = "public";
    let tableName = "";
    let body = "";
    if (quotedNameMatch) {
        schema = quotedNameMatch[1] || "public";
        tableName = quotedNameMatch[2];
        const open = afterExists.indexOf("(");
        const close = findMatchingParen(afterExists, open);
        body = close >= 0 ? afterExists.slice(open + 1, close) : "";
    } else {
        const singleMatch = afterExists.match(/^"([^"]+)"\s*\(/);
        if (!singleMatch) return null;
        tableName = singleMatch[1];
        const open = afterExists.indexOf("(");
        const close = findMatchingParen(afterExists, open);
        body = close >= 0 ? afterExists.slice(open + 1, close) : "";
    }

    const columns = parseColumnDefs(body);
    if (columns.length === 0) return null;

    return { schema, tableName, ifNotExists, columns };
}

function findMatchingParen(s: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Split body by top-level commas (ignore commas inside parens). */
function splitBodyParts(body: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) {
            parts.push(body.slice(start, i).trim());
            start = i + 1;
        }
    }
    if (start < body.length) parts.push(body.slice(start).trim());
    return parts;
}

function parseColumnDefs(body: string): Omit<ColumnRow, "_id">[] {
    const parts = splitBodyParts(body);
    const columns: Omit<ColumnRow, "_id">[] = [];
    const pkColumns = new Set<string>();

    for (const part of parts) {
        const upper = part.toUpperCase();
        if (upper.startsWith("PRIMARY KEY")) {
            const match = part.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
            if (match) {
                match[1].split(",").forEach((c) => pkColumns.add(c.replace(/"/g, "").trim()));
            }
            continue;
        }
        if (upper.startsWith("UNIQUE") || upper.startsWith("CHECK")) continue;

        const colMatch = part.match(/^"([^"]+)"\s+([a-zA-Z0-9_\s]+?)(?:\s+NOT\s+NULL|\s+DEFAULT\s|$)/i);
        if (!colMatch) continue;

        const colName = colMatch[1];
        let typePart = colMatch[2].trim();
        const notNull = /\bNOT\s+NULL\b/i.test(part);
        const defaultMatch = part.match(/\bDEFAULT\s+([\s\S]+?)(?:\s+PRIMARY|\s+UNIQUE|$)/i);
        const defaultVal = defaultMatch ? defaultMatch[1].trim() : null;
        const isPk = /\bPRIMARY\s+KEY\b/i.test(part);
        const isUnique = /\bUNIQUE\b/i.test(part);
        const checkMatch = part.match(/\bCHECK\s*\((.+)\)/i);
        const checkConstraint = checkMatch ? checkMatch[1].trim() : null;

        let dataType = typePart;
        let length: string | null = null;
        const lenMatch = typePart.match(/^(\w+)\s*\(([^)]+)\)$/);
        if (lenMatch) {
            dataType = lenMatch[1].toLowerCase();
            length = lenMatch[2].trim();
        } else {
            dataType = typePart.split(/\s+/)[0].toLowerCase();
        }

        columns.push({
            name: colName,
            data_type: dataType,
            length,
            is_nullable: !notNull,
            default_value: defaultVal,
            is_primary_key: isPk || pkColumns.has(colName),
            is_unique: isUnique,
            check_constraint: checkConstraint,
        });
    }

    for (const col of columns) {
        if (pkColumns.has(col.name) && !col.is_primary_key) {
            col.is_primary_key = true;
        }
    }

    return columns;
}

// ─── Type Selector ────────────────────────────────────────────────────────────

/** Match type names or group labels (e.g. "range" → all range types). */
function filterPgTypes(query: string): string[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const g of PG_TYPES) {
        const groupHit = g.group.toLowerCase().includes(q);
        for (const t of g.types) {
            if (seen.has(t)) continue;
            if (t.includes(q) || groupHit) {
                seen.add(t);
                out.push(t);
            }
        }
    }
    return out;
}

function TypeSelector({
    value,
    onChange,
}: {
    value: string;
    onChange: (v: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const filtered = search.trim() ? filterPgTypes(search) : null;

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    "flex w-full items-center justify-between h-8 px-3 rounded-lg border text-sm font-mono",
                    "bg-background border-input hover:border-primary/40 transition-colors",
                    "text-sky-400/90",
                    open && "border-primary ring-2 ring-primary/20"
                )}
            >
                <span className="truncate">{value || "select type"}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground ml-1 shrink-0" />
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 w-[min(100vw-2rem,20rem)] max-h-[calc(90vh-8rem)] overflow-hidden rounded-xl border border-border/40 bg-card shadow-xl flex flex-col">
                        <div className="shrink-0 px-2 py-2 border-b border-border/20">
                            <input
                                autoFocus
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search types…"
                                className="w-full h-6 px-2 text-xs rounded-md bg-background/60 border border-border/25 outline-none focus:border-primary/40"
                            />
                        </div>
                        <div
                            className={cn(
                                "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain",
                                "[scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]",
                            )}
                        >
                            <div className="py-1">
                                {filtered !== null ? (
                                    filtered.length === 0 ? (
                                        <div className="px-3 py-2 text-[10px] text-muted-foreground/60">No match</div>
                                    ) : (
                                        filtered.map((t) => (
                                            <button
                                                key={t}
                                                type="button"
                                                onClick={() => { onChange(t); setOpen(false); setSearch(""); }}
                                                className={cn(
                                                    "flex w-full items-center px-3 py-1.5 text-xs font-mono text-left hover:bg-accent/50 transition-colors",
                                                    value === t && "text-primary bg-primary/5"
                                                )}
                                            >
                                                {t}
                                                {value === t && <Check className="h-3 w-3 ml-auto" />}
                                            </button>
                                        ))
                                    )
                                ) : (
                                    PG_TYPES.map((group) => (
                                        <div key={group.group}>
                                            <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                                                {group.group}
                                            </div>
                                            {group.types.map((t) => (
                                                <button
                                                    key={t}
                                                    type="button"
                                                    onClick={() => { onChange(t); setOpen(false); }}
                                                    className={cn(
                                                        "flex w-full items-center px-3 py-1 text-xs font-mono text-left hover:bg-accent/50 transition-colors",
                                                        value === t && "text-primary bg-primary/5"
                                                    )}
                                                >
                                                    {t}
                                                    {value === t && <Check className="h-3 w-3 ml-auto" />}
                                                </button>
                                            ))}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                        <div className="shrink-0 border-t border-border/20 px-3 py-2 bg-card">
                            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-0.5">Custom</div>
                            <input
                                value={!ALL_TYPES.includes(value) ? value : ""}
                                onChange={(e) => onChange(e.target.value)}
                                placeholder="custom type…"
                                className="w-full h-6 px-2 text-xs font-mono rounded-md bg-background/60 border border-border/25 outline-none focus:border-primary/40"
                            />
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// ─── Column Row ───────────────────────────────────────────────────────────────

function ColumnEditorRow({
    col,
    index,
    total,
    onChange,
    onDelete,
    onMoveUp,
    onMoveDown,
    errors,
}: {
    col: ColumnRow;
    index: number;
    total: number;
    onChange: (id: string, patch: Partial<ColumnRow>) => void;
    onDelete: (id: string) => void;
    onMoveUp: (id: string) => void;
    onMoveDown: (id: string) => void;
    errors: ValidationError[];
}) {
    const [showCheck, setShowCheck] = useState(false);
    const hasNameError = errors.some((e) => e.field === `col_name_${index}` || e.field === `col_dup_${index}`);
    const hasPkNullError = errors.some((e) => e.field === `col_pk_null_${index}`);
    const needsLength = LENGTH_TYPES.has(col.data_type);

    return (
        <div className={cn(
            "group border-b border-border/10 last:border-b-0 transition-colors",
            "hover:bg-accent/5",
            (hasNameError || hasPkNullError) && "bg-destructive/5"
        )}>
            <div className="grid grid-cols-[auto_1fr_1fr_4rem_4rem_1fr_2.5rem_2.5rem_2.5rem_auto] gap-3 px-4 py-2 items-center">
                {/* Grip + ordinal */}
                <div className="flex items-center gap-0.5 w-8 justify-end">
                    <GripVertical className="h-3 w-3 text-muted-foreground/20 group-hover:text-muted-foreground/50" />
                    <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
                        {index + 1}
                    </span>
                </div>

                {/* Name */}
                <div className="min-w-[120px]">
                    <Input
                        value={col.name}
                        onChange={(e) => onChange(col._id, { name: e.target.value })}
                        placeholder="column_name"
                        className={cn(
                            "h-8 text-sm font-mono bg-background",
                            hasNameError && "border-destructive focus-visible:ring-destructive/30"
                        )}
                    />
                </div>

                {/* Type */}
                <div className="min-w-[120px]">
                    <TypeSelector
                        value={col.data_type}
                        onChange={(v) => onChange(col._id, { data_type: v, length: LENGTH_TYPES.has(v) ? col.length : null })}
                    />
                </div>

                {/* Length */}
                <div className="w-16">
                    <Input
                        value={col.length ?? ""}
                        onChange={(e) => onChange(col._id, { length: e.target.value || null })}
                        placeholder={needsLength ? "255" : "—"}
                        disabled={!needsLength && !col.length}
                        className="h-8 text-sm font-mono bg-background text-center"
                    />
                </div>

                {/* Nullable toggle */}
                <div className="flex justify-center">
                    <button
                        type="button"
                        onClick={() => onChange(col._id, { is_nullable: !col.is_nullable })}
                        className={cn(
                            "h-6 w-10 rounded-full transition-colors border-2",
                            col.is_nullable
                                ? "bg-primary border-primary"
                                : "bg-muted border-muted-foreground/30"
                        )}
                        title={col.is_nullable ? "NULL allowed" : "NOT NULL"}
                    />
                </div>

                {/* Default */}
                <div className="min-w-[80px]">
                    <Input
                        value={col.default_value ?? ""}
                        onChange={(e) => onChange(col._id, { default_value: e.target.value || null })}
                        placeholder="—"
                        className="h-8 text-sm font-mono bg-background"
                    />
                </div>

                {/* PK */}
                <div className="flex justify-center">
                    <button
                        type="button"
                        title="Primary Key"
                        onClick={() => onChange(col._id, {
                            is_primary_key: !col.is_primary_key,
                            is_nullable: col.is_primary_key ? col.is_nullable : false,
                        })}
                        className={cn(
                            "h-8 w-8 rounded-md flex items-center justify-center transition-colors border-2",
                            col.is_primary_key
                                ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
                                : "border-border/40 text-muted-foreground/40 hover:border-amber-500/40 hover:text-amber-400"
                        )}
                    >
                        <Key className="h-3.5 w-3.5" />
                    </button>
                </div>

                {/* Unique */}
                <div className="flex justify-center">
                    <button
                        type="button"
                        title="Unique"
                        onClick={() => onChange(col._id, { is_unique: !col.is_unique })}
                        className={cn(
                            "h-8 w-8 rounded-md flex items-center justify-center transition-colors border-2 text-xs font-bold",
                            col.is_unique
                                ? "bg-violet-500/20 border-violet-500/50 text-violet-400"
                                : "border-border/40 text-muted-foreground/40 hover:border-violet-500/40 hover:text-violet-400"
                        )}
                    >
                        UQ
                    </button>
                </div>

                {/* Check toggle */}
                <div className="flex justify-center">
                    <button
                        type="button"
                        title="Check Constraint"
                        onClick={() => setShowCheck((s) => !s)}
                        className={cn(
                            "h-8 w-8 rounded-md flex items-center justify-center transition-colors border-2 text-xs font-bold",
                            col.check_constraint?.trim()
                                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400"
                                : "border-border/40 text-muted-foreground/40 hover:border-emerald-500/40 hover:text-emerald-400"
                        )}
                    >
                        CK
                    </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 w-24">
                    <button
                        type="button"
                        onClick={() => onMoveUp(col._id)}
                        disabled={index === 0}
                        className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent disabled:opacity-30 transition-colors"
                    >
                        <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => onMoveDown(col._id)}
                        disabled={index === total - 1}
                        className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent disabled:opacity-30 transition-colors"
                    >
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => onDelete(col._id)}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            {/* Inline check constraint input */}
            {showCheck && (
                <div className="px-4 pb-3 pl-14 flex items-center gap-2 bg-muted/5 border-t border-border/5">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/70 shrink-0" />
                    <Input
                        autoFocus
                        value={col.check_constraint ?? ""}
                        onChange={(e) => onChange(col._id, { check_constraint: e.target.value || null })}
                        placeholder="e.g. age >= 0"
                        className="h-8 text-sm font-mono bg-background flex-1 max-w-md"
                    />
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowCheck(false)}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

export interface CreateTableDialogProps {
    open: boolean;
    onClose: () => void;
    defaultSchema?: string;
    schemas: string[];
    /** Called after successful creation so the sidebar can refresh */
    onCreated: (schema: string, tableName: string) => void;
}

export function CreateTableDialog({
    open,
    onClose,
    defaultSchema = "public",
    schemas,
    onCreated,
}: CreateTableDialogProps) {
    const { connectionId } = useConnectionStore();

    const [tableName, setTableName] = useState("");
    const [schema, setSchema] = useState(defaultSchema);
    const [ifNotExists, setIfNotExists] = useState(false);
    const [columns, setColumns] = useState<ColumnRow[]>([makeDefaultColumn(0)]);
    const [activeTab, setActiveTab] = useState("columns");
    const [loading, setLoading] = useState(false);
    const [generatedSql, setGeneratedSql] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [editSqlMode, setEditSqlMode] = useState(false);
    const [editedSql, setEditedSql] = useState("");
    const [sqlParseError, setSqlParseError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setEditSqlMode(false);
            setEditedSql("");
            setSqlParseError(null);
        }
    }, [open]);

    const errors = useMemo(
        () => validateAll(tableName, schema, columns),
        [tableName, schema, columns]
    );

    const sqlPreview = useMemo(
        () => buildSqlPreview(tableName, schema, columns, ifNotExists),
        [tableName, schema, columns, ifNotExists]
    );

    const updateColumn = useCallback((id: string, patch: Partial<ColumnRow>) => {
        setColumns((prev) => prev.map((c) => (c._id === id ? { ...c, ...patch } : c)));
    }, []);

    const deleteColumn = useCallback((id: string) => {
        setColumns((prev) => prev.filter((c) => c._id !== id));
    }, []);

    const moveUp = useCallback((id: string) => {
        setColumns((prev) => {
            const i = prev.findIndex((c) => c._id === id);
            if (i <= 0) return prev;
            const next = [...prev];
            [next[i - 1], next[i]] = [next[i], next[i - 1]];
            return next;
        });
    }, []);

    const moveDown = useCallback((id: string) => {
        setColumns((prev) => {
            const i = prev.findIndex((c) => c._id === id);
            if (i < 0 || i >= prev.length - 1) return prev;
            const next = [...prev];
            [next[i], next[i + 1]] = [next[i + 1], next[i]];
            return next;
        });
    }, []);

    const addColumn = () => {
        setColumns((prev) => [...prev, makeDefaultColumn(prev.length)]);
    };

    const addIdColumn = () => {
        const idCol: ColumnRow = {
            _id: `col-id-${Date.now()}`,
            name: "id",
            data_type: "bigserial",
            length: null,
            is_nullable: false,
            default_value: null,
            is_primary_key: true,
            is_unique: false,
            check_constraint: null,
        };
        setColumns((prev) => [idCol, ...prev]);
    };

    const addTimestampColumns = () => {
        const now: ColumnRow = {
            _id: `col-ts-${Date.now()}`,
            name: "created_at",
            data_type: "timestamptz",
            length: null,
            is_nullable: false,
            default_value: "now()",
            is_primary_key: false,
            is_unique: false,
            check_constraint: null,
        };
        const updated: ColumnRow = {
            _id: `col-ts2-${Date.now()}`,
            name: "updated_at",
            data_type: "timestamptz",
            length: null,
            is_nullable: false,
            default_value: "now()",
            is_primary_key: false,
            is_unique: false,
            check_constraint: null,
        };
        setColumns((prev) => [...prev, now, updated]);
    };

    const handleCreate = async () => {
        if (!connectionId) return;
        if (errors.length > 0) {
            setActiveTab("columns");
            return;
        }

        setLoading(true);
        try {
            const sql = await dbCreateTable(
                connectionId,
                schema,
                tableName.trim(),
                columns.map(({ _id: _, ...c }) => ({
                    ...c,
                    name: c.name.trim(),
                    data_type: c.data_type.trim(),
                })),
                ifNotExists
            );
            setGeneratedSql(sql);
            toast.success(`Table "${schema}"."${tableName}" created`, {
                description: `${columns.length} column${columns.length !== 1 ? "s" : ""} defined`,
            });
            onCreated(schema, tableName.trim());
            handleClose();
        } catch (e) {
            const msg = String(e);
            toast.error("Failed to create table", {
                description: parseDbError(msg),
                duration: 8000,
            });
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        setTableName("");
        setSchema(defaultSchema);
        setIfNotExists(false);
        setColumns([makeDefaultColumn(0)]);
        setActiveTab("columns");
        setGeneratedSql(null);
        onClose();
    };

    const copySQL = () => {
        const text = editSqlMode ? editedSql : sqlPreview;
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleEnterEditSql = () => {
        setEditedSql(sqlPreview);
        setEditSqlMode(true);
        setSqlParseError(null);
    };

    const tableNameError = errors.find((e) => e.field === "table_name");

    return (
        <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
            <DialogContent
                className={cn(
                    "max-w-[95vw] sm:max-w-7xl w-full h-[90vh] flex flex-col p-0 gap-0 overflow-hidden",
                    "rounded-xl border-border/40 shadow-2xl"
                )}
            >
                {/* ── Header ── */}
                <div className="flex items-center gap-4 px-6 pt-6 pb-4 border-b border-border/20 shrink-0 bg-card/30">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/20 shrink-0">
                        <Table2 className="h-6 w-6 text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <DialogTitle className="text-base font-semibold tracking-tight">Create New Table</DialogTitle>
                        <DialogDescription className="text-xs text-muted-foreground/80 mt-0.5">
                            Define columns, constraints, and generate a CREATE TABLE statement
                        </DialogDescription>
                    </div>
                </div>

                {/* ── Table Identity ── */}
                <div className="px-6 py-4 border-b border-border/10 bg-muted/5 shrink-0">
                    <div className="flex flex-wrap items-end gap-6">
                        {/* Schema */}
                        <div className="flex flex-col gap-1.5 min-w-[140px]">
                            <label className="text-xs font-medium text-muted-foreground">Schema</label>
                            <select
                                value={schema}
                                onChange={(e) => setSchema(e.target.value)}
                                className={cn(
                                    "h-9 px-3 rounded-lg border text-sm font-mono bg-background",
                                    "border-input hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-colors",
                                    "min-w-[120px]"
                                )}
                            >
                                {schemas.map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>

                        <span className="text-muted-foreground/40 text-lg font-mono pb-2 leading-none">.</span>

                        {/* Table name */}
                        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px] max-w-md">
                            <label className="text-xs font-medium text-muted-foreground">Table name</label>
                            <Input
                                autoFocus
                                value={tableName}
                                onChange={(e) => setTableName(e.target.value)}
                                placeholder="e.g. users"
                                className={cn(
                                    "h-9 text-sm font-mono bg-background",
                                    tableNameError && "border-destructive focus-visible:ring-destructive/30"
                                )}
                            />
                            {tableNameError && (
                                <p className="text-xs text-destructive flex items-center gap-1">
                                    <AlertCircle className="h-3 w-3 shrink-0" />
                                    {tableNameError.message}
                                </p>
                            )}
                        </div>

                        {/* IF NOT EXISTS */}
                        <label className="flex items-center gap-2.5 cursor-pointer shrink-0 pb-1">
                            <div
                                role="checkbox"
                                aria-checked={ifNotExists}
                                className={cn(
                                    "h-4 w-4 rounded border-2 transition-colors flex items-center justify-center shrink-0",
                                    ifNotExists
                                        ? "bg-primary border-primary"
                                        : "border-muted-foreground/40 hover:border-primary/50"
                                )}
                                onClick={() => setIfNotExists((v) => !v)}
                            >
                                {ifNotExists && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                            </div>
                            <span className="text-xs text-muted-foreground select-none">IF NOT EXISTS</span>
                        </label>
                    </div>
                </div>

                {/* ── Body ── */}
                <div className="flex-1 min-h-0 flex">
                    {/* Column editor + SQL */}
                    <div className="flex-1 min-w-0 flex flex-col border-r border-border/10">
                        <Tabs
                            value={activeTab}
                            onValueChange={(tab) => {
                                if (tab === "columns" && activeTab === "preview" && editSqlMode && editedSql.trim()) {
                                    const parsed = parseCreateTableSql(editedSql);
                                    if (parsed) {
                                        setSchema(parsed.schema);
                                        setTableName(parsed.tableName);
                                        setIfNotExists(parsed.ifNotExists);
                                        setColumns(
                                            parsed.columns.map((c, i) => ({
                                                ...c,
                                                _id: `col-${Date.now()}-${i}`,
                                            }))
                                        );
                                        setSqlParseError(null);
                                        toast.success("SQL applied to columns");
                                    } else {
                                        setSqlParseError("Could not parse SQL. Check CREATE TABLE syntax.");
                                        return;
                                    }
                                    setEditSqlMode(false);
                                }
                                setActiveTab(tab);
                            }}
                            className="flex-1 flex flex-col min-h-0"
                        >
                            <div className="flex items-center justify-between px-4 py-3 border-b border-border/10 shrink-0 bg-muted/5">
                                <TabsList className="h-9 bg-muted/40 rounded-lg p-1 gap-0.5">
                                    <TabsTrigger value="columns" className="h-7 text-xs px-4 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                                        <Columns className="h-3.5 w-3.5" />
                                        Columns ({columns.length})
                                    </TabsTrigger>
                                    <TabsTrigger value="preview" className="h-7 text-xs px-4 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                                        <Code2 className="h-3.5 w-3.5" />
                                        SQL Preview
                                    </TabsTrigger>
                                </TabsList>

                                {/* Quick-add buttons */}
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                                        onClick={addIdColumn}
                                        title="Add id bigserial PRIMARY KEY column"
                                    >
                                        <Key className="h-3 w-3" /> +id
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5 border-sky-500/30 text-sky-400 hover:bg-sky-500/10"
                                        onClick={addTimestampColumns}
                                        title="Add created_at / updated_at timestamp columns"
                                    >
                                        <Sparkles className="h-3 w-3" /> +timestamps
                                    </Button>
                                    <Button
                                        variant="default"
                                        size="sm"
                                        className="h-8 text-xs gap-1.5"
                                        onClick={addColumn}
                                    >
                                        <Plus className="h-3 w-3" /> Add column
                                    </Button>
                                </div>
                            </div>

                            {/* Columns Tab */}
                            <TabsContent value="columns" className="flex-1 m-0 flex flex-col min-h-0">
                                {/* Column table header */}
                                <div className="grid grid-cols-[auto_1fr_1fr_4rem_4rem_1fr_2.5rem_2.5rem_2.5rem_auto] gap-3 px-4 py-2.5 border-b border-border/10 bg-muted/10 shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                                    <div className="w-8" />
                                    <div className="min-w-[140px]">Name</div>
                                    <div className="min-w-[130px]">Type</div>
                                    <div className="text-center">Len</div>
                                    <div className="text-center">Null</div>
                                    <div className="min-w-[100px]">Default</div>
                                    <div className="text-center" title="Primary Key">PK</div>
                                    <div className="text-center" title="Unique">UQ</div>
                                    <div className="text-center" title="Check">CK</div>
                                    <div className="w-24" />
                                </div>
                                <ScrollArea className="flex-1">
                                    {columns.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/50">
                                            <Columns className="h-12 w-12 mb-4 opacity-30" />
                                            <p className="text-sm font-medium">No columns defined</p>
                                            <p className="text-xs mt-1">Add at least one column to create the table</p>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="mt-4 gap-2"
                                                onClick={addColumn}
                                            >
                                                <Plus className="h-4 w-4" /> Add column
                                            </Button>
                                        </div>
                                    ) : (
                                        columns.map((col, i) => (
                                            <ColumnEditorRow
                                                key={col._id}
                                                col={col}
                                                index={i}
                                                total={columns.length}
                                                onChange={updateColumn}
                                                onDelete={deleteColumn}
                                                onMoveUp={moveUp}
                                                onMoveDown={moveDown}
                                                errors={errors}
                                            />
                                        ))
                                    )}
                                </ScrollArea>
                            </TabsContent>

                            {/* SQL Preview Tab */}
                            <TabsContent value="preview" className="flex-1 m-0 flex flex-col min-h-0">
                                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/10 bg-muted/5 shrink-0 gap-2">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        {editSqlMode ? "Edit SQL" : "Generated SQL"}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        {editSqlMode ? (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 text-xs gap-1.5"
                                                onClick={() => {
                                                    setEditSqlMode(false);
                                                    setSqlParseError(null);
                                                }}
                                            >
                                                Cancel edit
                                            </Button>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 text-xs gap-1.5"
                                                onClick={handleEnterEditSql}
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                                Edit SQL
                                            </Button>
                                        )}
                                        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={copySQL}>
                                            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                                            {copied ? "Copied" : "Copy"}
                                        </Button>
                                    </div>
                                </div>
                                {sqlParseError && (
                                    <div className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                        {sqlParseError}
                                    </div>
                                )}
                                <ScrollArea className="flex-1">
                                    {editSqlMode ? (
                                        <textarea
                                            value={editedSql}
                                            onChange={(e) => {
                                                setEditedSql(e.target.value);
                                                setSqlParseError(null);
                                            }}
                                            className="w-full min-h-[200px] p-5 text-sm font-mono leading-relaxed text-foreground/90 bg-transparent border-0 resize-none focus:outline-none focus:ring-0"
                                            placeholder="CREATE TABLE ..."
                                            spellCheck={false}
                                        />
                                    ) : (
                                        <pre className="p-5 text-sm font-mono leading-relaxed text-foreground/90 whitespace-pre-wrap break-all">
                                            {sqlPreview}
                                        </pre>
                                    )}
                                </ScrollArea>
                                {editSqlMode && (
                                    <p className="px-4 py-2 text-[10px] text-muted-foreground/70 border-t border-border/10">
                                        Switch to the Columns tab to apply this SQL — column definitions will be updated from the statement.
                                    </p>
                                )}
                            </TabsContent>
                        </Tabs>
                    </div>

                    {/* Right: Validation panel */}
                    <div className="w-72 shrink-0 flex flex-col border-l border-border/10 bg-muted/5">
                        <div className="px-4 py-3 border-b border-border/10 shrink-0">
                            <p className="text-xs font-semibold text-muted-foreground">
                                Validation
                            </p>
                        </div>
                        <ScrollArea className="flex-1">
                            <div className="p-4 space-y-3">
                                {errors.length === 0 ? (
                                    <div className="flex items-center gap-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5">
                                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                                        <p className="text-xs font-medium text-emerald-400">Ready to execute</p>
                                    </div>
                                ) : (
                                    errors.map((err, i) => (
                                        <div
                                            key={i}
                                            className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5"
                                        >
                                            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                                            <p className="text-xs text-destructive leading-snug">{err.message}</p>
                                        </div>
                                    ))
                                )}

                                <div className="pt-3 border-t border-border/10 space-y-2">
                                    {[
                                        { label: "Columns", value: columns.length, color: "text-sky-400" },
                                        { label: "Primary keys", value: columns.filter((c) => c.is_primary_key).length, color: "text-amber-400" },
                                        { label: "Unique", value: columns.filter((c) => c.is_unique).length, color: "text-violet-400" },
                                        { label: "Not null", value: columns.filter((c) => !c.is_nullable).length, color: "text-rose-400" },
                                        { label: "With default", value: columns.filter((c) => c.default_value).length, color: "text-emerald-400" },
                                        { label: "With check", value: columns.filter((c) => c.check_constraint?.trim()).length, color: "text-green-400" },
                                    ].map(({ label, value, color }) => (
                                        <div key={label} className="flex items-center justify-between text-xs">
                                            <span className="text-muted-foreground/70">{label}</span>
                                            <span className={cn("font-mono font-semibold tabular-nums", color)}>{value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </ScrollArea>
                    </div>
                </div>

                {/* ── Footer ── */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-border/20 bg-card/30 shrink-0">
                    <div className="text-sm font-mono text-muted-foreground/70">
                        {schema && tableName ? (
                            <span className="text-foreground/80">"{schema}"."{tableName}"</span>
                        ) : (
                            <span className="italic">—</span>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <Button variant="outline" onClick={handleClose} disabled={loading}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={loading || errors.length > 0}
                            className="gap-2 min-w-[140px]"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Creating…
                                </>
                            ) : errors.length > 0 ? (
                                <>
                                    <AlertCircle className="h-4 w-4" />
                                    Fix {errors.length} error{errors.length !== 1 ? "s" : ""}
                                </>
                            ) : (
                                <>
                                    <Table2 className="h-4 w-4" />
                                    Create table
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── Error parser ─────────────────────────────────────────────────────────────

function parseDbError(raw: string): string {
    // Strip "Create table error: " prefix
    const msg = raw.replace(/^create table error:\s*/i, "");

    // Postgres "already exists"
    if (/already exists/i.test(msg)) {
        return "A table with this name already exists in the schema. Use IF NOT EXISTS or choose a different name.";
    }
    // Duplicate column
    if (/column .* specified more than once/i.test(msg)) {
        return "Two or more columns have the same name. Each column name must be unique.";
    }
    // Syntax error
    if (/syntax error/i.test(msg)) {
        return `SQL syntax error — check your type names, defaults, or check constraints.\n\nDetails: ${msg}`;
    }
    // Permission
    if (/permission denied/i.test(msg)) {
        return "You do not have permission to create tables in this schema.";
    }
    // Schema not found
    if (/schema .* does not exist/i.test(msg)) {
        return "The selected schema does not exist. Please refresh and try again.";
    }

    return msg;
}
