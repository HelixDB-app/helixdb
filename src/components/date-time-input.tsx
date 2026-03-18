"use client";

import { useMemo, useState } from "react";
import type { KeyboardEventHandler } from "react";
import { Calendar as CalendarIcon, Clock } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DateTimeMode } from "@/lib/date-time";

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function normalizeTime(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const clean = trimmed.split(".")[0];
    const parts = clean.split(":");
    if (parts.length < 2) return clean;
    const hh = pad(Number(parts[0]));
    const mm = pad(Number(parts[1]));
    const ss = pad(Number(parts[2] ?? 0));
    return `${hh}:${mm}:${ss}`;
}

function parseValue(value: string, mode: DateTimeMode): { date: Date | null; time: string } {
    if (!value) return { date: null, time: "" };
    const dateMatch = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    const timeMatch = value.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
    const time = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] ?? "00"}` : "";

    if (mode === "time") return { date: null, time: normalizeTime(time) };
    if (!dateMatch) return { date: null, time: normalizeTime(time) };

    const y = Number(dateMatch[1]);
    const m = Number(dateMatch[2]);
    const d = Number(dateMatch[3]);
    const date = new Date(y, m - 1, d);

    if (timeMatch) {
        date.setHours(
            Number(timeMatch[1]),
            Number(timeMatch[2]),
            Number(timeMatch[3] ?? 0),
            0
        );
    }
    return { date, time: normalizeTime(time) };
}

function formatDate(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildValue(mode: DateTimeMode, date: Date | null, time: string): string {
    if (mode === "time") return normalizeTime(time) || "";
    if (!date) return "";
    const datePart = formatDate(date);
    if (mode === "date") return datePart;
    const timePart = normalizeTime(time) || "00:00:00";
    return `${datePart} ${timePart}`;
}

export interface DateTimeInputProps {
    value: string;
    mode: DateTimeMode;
    onChange: (value: string) => void;
    disabled?: boolean;
    inputClassName?: string;
    onBlur?: () => void;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function DateTimeInput({
    value,
    mode,
    onChange,
    disabled,
    inputClassName,
    onBlur,
    onKeyDown,
    open,
    onOpenChange,
}: DateTimeInputProps) {
    const parsed = useMemo(() => parseValue(value, mode), [value, mode]);
    const [internalOpen, setInternalOpen] = useState(false);
    const isOpen = open ?? internalOpen;
    const setOpen = onOpenChange ?? setInternalOpen;

    const handleDateSelect = (next: Date | undefined) => {
        if (!next) return;
        const nextValue = buildValue(mode, next, parsed.time);
        onChange(nextValue);
    };

    const handleTimeChange = (raw: string) => {
        const nextTime = normalizeTime(raw);
        const baseDate = parsed.date ?? new Date();
        const nextValue = buildValue(mode, baseDate, nextTime);
        onChange(nextValue);
    };

    const dateLabel = parsed.date
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed.date)
        : "Pick a date";

    return (
        <div className="relative flex w-full items-center">
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                disabled={disabled}
                className={cn(inputClassName, "pr-9")}
                placeholder={mode === "date" ? "YYYY-MM-DD" : mode === "time" ? "HH:mm:ss" : "YYYY-MM-DD HH:mm:ss"}
            />
            <Popover open={isOpen} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 h-7 w-7 text-muted-foreground hover:text-foreground"
                        onMouseDown={(e) => e.preventDefault()}
                        disabled={disabled}
                        aria-label="Pick date/time"
                    >
                        <CalendarIcon className="h-3.5 w-3.5" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-3" align="end">
                    {mode !== "time" && (
                        <div>
                            <div className="text-[11px] font-medium text-muted-foreground mb-2">
                                {dateLabel}
                            </div>
                            <Calendar
                                mode="single"
                                selected={parsed.date ?? undefined}
                                onSelect={handleDateSelect}
                                initialFocus
                            />
                        </div>
                    )}
                    {mode !== "date" && (
                        <div className="mt-3 flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                type="time"
                                step={1}
                                value={parsed.time}
                                onChange={(e) => handleTimeChange(e.target.value)}
                                className="h-8 text-xs"
                            />
                            <span className="text-[10px] text-muted-foreground/60">Local</span>
                        </div>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    );
}
