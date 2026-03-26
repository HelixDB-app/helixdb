"use client";

import { memo, useMemo, useCallback, type RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { DateTimeInput } from "@/components/date-time-input";
import { getDateTimeMode } from "@/lib/date-time";
import type { ColumnInfo, ResultColumn, TableConstraint } from "@/lib/types";
import { cn } from "@/lib/utils";

export type RowFormVariant = "insert" | "edit";

export function hasColumnDefault(col: ColumnInfo): boolean {
    return col.column_default != null && col.column_default.trim() !== "";
}

export function insertPlaceholder(col: ColumnInfo): string {
    if (hasColumnDefault(col)) return "DEFAULT";
    if (col.is_nullable) return "NULL";
    return "Value…";
}

function useFkByColumn(constraints: TableConstraint[] | null | undefined) {
    return useMemo(() => {
        const m = new Map<string, { refTable: string; refCol: string }>();
        if (!constraints) return m;
        for (const c of constraints) {
            if (c.constraint_type === "f" && c.columns.length > 0 && c.foreign_table && c.foreign_columns?.length) {
                m.set(c.columns[0], { refTable: c.foreign_table, refCol: c.foreign_columns[0] });
            }
        }
        return m;
    }, [constraints]);
}

function useEnumByName(resultColumns: ResultColumn[] | null | undefined) {
    return useMemo(() => {
        const m = new Map<string, string[]>();
        if (!resultColumns) return m;
        for (const rc of resultColumns) {
            if (rc.enum_labels?.length) m.set(rc.name, rc.enum_labels);
        }
        return m;
    }, [resultColumns]);
}

type RowFormFieldRowProps = {
    col: ColumnInfo;
    variant: RowFormVariant;
    value: string;
    onChange: (name: string, value: string) => void;
    error?: string;
    disabled: boolean;
    enumLabels: string[] | null;
    fk: { refTable: string; refCol: string } | undefined;
    inputId: string;
};

const RowFormFieldRow = memo(function RowFormFieldRow({
    col,
    variant,
    value,
    onChange,
    error,
    disabled,
    enumLabels,
    fk,
    inputId,
}: RowFormFieldRowProps) {
    const lowerType = col.data_type.toLowerCase();
    const isBoolType = lowerType === "bool" || lowerType === "boolean";
    const dateTimeMode = getDateTimeMode(col.data_type);
    const isPk = col.is_primary_key;
    const textPlaceholder = variant === "insert" ? insertPlaceholder(col) : col.is_nullable ? "NULL" : undefined;

    const selectValue = col.is_nullable && value === "" ? "__null__" : value;
    const selectControlledValue =
        !col.is_nullable && value === "" ? undefined : selectValue;

    const handleSelect = useCallback(
        (v: string) => {
            onChange(col.name, v === "__null__" ? "" : v);
        },
        [col.name, onChange]
    );

    const handleInput = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            onChange(col.name, e.target.value);
        },
        [col.name, onChange]
    );

    const inputClass = cn(
        "h-9 text-xs font-mono bg-background/80",
        error && "border-destructive/50 focus-visible:ring-destructive/30"
    );

    if (col.is_generated) {
        return (
            <div className="space-y-1.5 min-w-0">
                <Label htmlFor={inputId} className="text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cn("font-mono", isPk && "text-amber-500 font-semibold")}>{col.name}</span>
                    <span className="text-[10px] text-muted-foreground/70 font-mono font-normal tabular-nums">
                        {col.data_type}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider bg-violet-500/15 text-violet-400 px-1.5 rounded-sm">
                        Generated
                    </span>
                </Label>
                {col.comment?.trim() ? (
                    <p className="text-[11px] text-muted-foreground/70 leading-snug">{col.comment.trim()}</p>
                ) : null}
                <Input
                    id={inputId}
                    readOnly
                    value={value}
                    className={cn(inputClass, "cursor-default opacity-85 bg-muted/30")}
                    tabIndex={-1}
                />
                <p className="text-[10px] text-muted-foreground/80">
                    Maintained by PostgreSQL; excluded from insert/update payloads.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-1.5 min-w-0">
            <Label htmlFor={inputId} className="text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={cn("font-mono", isPk && "text-amber-500 font-semibold")}>{col.name}</span>
                <span className="text-[10px] text-muted-foreground/70 font-mono font-normal tabular-nums">
                    {col.data_type}
                </span>
                {isPk && (
                    <span className="text-[9px] uppercase tracking-wider bg-amber-500/10 text-amber-500 px-1.5 rounded-sm">
                        PK
                    </span>
                )}
                {fk && (
                    <span className="text-[9px] font-mono text-sky-500/90 bg-sky-500/10 px-1.5 rounded-sm truncate max-w-full">
                        FK→{fk.refTable}.{fk.refCol}
                    </span>
                )}
                {!col.is_nullable && !hasColumnDefault(col) && !isPk && (
                    <span className="text-destructive/80 text-[10px]">*</span>
                )}
                {hasColumnDefault(col) && (
                    <span className="text-[9px] text-muted-foreground/60">default</span>
                )}
            </Label>
            {col.comment?.trim() ? (
                <p className="text-[11px] text-muted-foreground/70 leading-snug">{col.comment.trim()}</p>
            ) : null}
            {enumLabels ? (
                <Select value={selectControlledValue} onValueChange={handleSelect} disabled={disabled}>
                    <SelectTrigger id={inputId} className={cn(inputClass, "w-full")}>
                        <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                        {col.is_nullable && <SelectItem value="__null__">—</SelectItem>}
                        {enumLabels.map((label) => (
                            <SelectItem key={label} value={label}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : isBoolType ? (
                <Select value={selectControlledValue} onValueChange={handleSelect} disabled={disabled}>
                    <SelectTrigger id={inputId} className={cn(inputClass, "w-full")}>
                        <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                        {col.is_nullable && <SelectItem value="__null__">—</SelectItem>}
                        <SelectItem value="true">true</SelectItem>
                        <SelectItem value="false">false</SelectItem>
                    </SelectContent>
                </Select>
            ) : dateTimeMode ? (
                <DateTimeInput
                    value={value}
                    mode={dateTimeMode}
                    onChange={(v) => onChange(col.name, v)}
                    disabled={disabled}
                    inputClassName={inputClass}
                />
            ) : (
                <Input
                    id={inputId}
                    aria-invalid={Boolean(error)}
                    value={value}
                    onChange={handleInput}
                    placeholder={textPlaceholder}
                    className={inputClass}
                    disabled={disabled}
                    autoComplete="off"
                />
            )}
            {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        </div>
    );
});

export interface RowFormFieldsProps {
    columns: ColumnInfo[];
    values: Record<string, string>;
    onChange: (name: string, value: string) => void;
    errors?: Record<string, string>;
    disabled?: boolean;
    variant: RowFormVariant;
    /** Enum labels from query metadata (grid columns). */
    resultColumns?: ResultColumn[] | null;
    /** When set, only columns whose name matches (case-insensitive substring). */
    columnFilter?: string;
    constraints?: TableConstraint[] | null;
    contentRef?: RefObject<HTMLDivElement | null>;
    /** e.g. `grid-cols-1` for narrow drawers; default is responsive two columns on large screens. */
    gridClassName?: string;
}

export function RowFormFields({
    columns,
    values,
    onChange,
    errors = {},
    disabled = false,
    variant,
    resultColumns,
    columnFilter = "",
    constraints,
    contentRef,
    gridClassName = "grid-cols-1 lg:grid-cols-2",
}: RowFormFieldsProps) {
    const fkByColumn = useFkByColumn(constraints);
    const enumByName = useEnumByName(resultColumns ?? null);

    const visibleColumns = useMemo(() => {
        const q = columnFilter.trim().toLowerCase();
        if (!q) return columns;
        return columns.filter((c) => c.name.toLowerCase().includes(q));
    }, [columns, columnFilter]);

    return (
        <div ref={contentRef} className={cn("grid gap-x-8 gap-y-5 pb-2", gridClassName)}>
            {visibleColumns.map((col) => (
                <RowFormFieldRow
                    key={col.name}
                    col={col}
                    variant={variant}
                    value={values[col.name] ?? ""}
                    onChange={onChange}
                    error={errors[col.name]}
                    disabled={disabled}
                    enumLabels={enumByName.get(col.name) ?? null}
                    fk={fkByColumn.get(col.name)}
                    inputId={`row-form-${col.name}`}
                />
            ))}
        </div>
    );
}
