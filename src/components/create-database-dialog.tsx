"use client";

import { useState, useEffect, useRef } from "react";
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
import { useConnectionStore } from "@/stores/connection-store";
import { AlertCircle, Database, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const DB_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

function validateName(name: string): string | null {
    if (!name.trim()) return "Database name is required.";
    if (name.length > 63) return "Name must be 63 characters or fewer.";
    if (!DB_NAME_REGEX.test(name))
        return "Name must start with a letter or underscore and contain only letters, numbers, underscores, or dollar signs.";
    return null;
}

interface CreateDatabaseDialogProps {
    open: boolean;
    onClose: () => void;
    onCreated: (name: string) => void;
}

export function CreateDatabaseDialog({
    open,
    onClose,
    onCreated,
}: CreateDatabaseDialogProps) {
    const { createDatabase, databases } = useConnectionStore();
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setName("");
            setError(null);
            setIsSubmitting(false);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [open]);

    const handleNameChange = (value: string) => {
        setName(value);
        if (error) setError(null);
    };

    const handleSubmit = async () => {
        const trimmed = name.trim();
        const validationError = validateName(trimmed);
        if (validationError) {
            setError(validationError);
            return;
        }
        if (databases.includes(trimmed)) {
            setError(`Database "${trimmed}" already exists.`);
            return;
        }

        setIsSubmitting(true);
        setError(null);
        try {
            await createDatabase(trimmed);
            toast.success(`Database "${trimmed}" created`);
            onCreated(trimmed);
            onClose();
        } catch (err) {
            const msg = String(err).replace(/^[a-z_]+:\s*/i, "");
            setError(msg || "Failed to create database.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isSubmitting) handleSubmit();
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-sm">
                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/20">
                            <Database className="h-3.5 w-3.5 text-amber-400" />
                        </div>
                        Create Database
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                        Create a new PostgreSQL database on this server.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 py-1">
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                            Database name <span className="text-destructive">*</span>
                        </label>
                        <Input
                            ref={inputRef}
                            value={name}
                            onChange={(e) => handleNameChange(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="e.g. my_database"
                            className={cn(
                                "h-9 text-sm font-mono",
                                error && "border-destructive focus-visible:ring-destructive/30"
                            )}
                            disabled={isSubmitting}
                            maxLength={63}
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <p className="text-[10px] text-muted-foreground/60">
                            Letters, numbers, underscores, dollar signs. Max 63 chars.
                        </p>
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
                            <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                            <p className="text-xs text-destructive">{error}</p>
                        </div>
                    )}
                </div>

                <DialogFooter className="gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={handleSubmit}
                        disabled={isSubmitting || !name.trim()}
                        className="gap-1.5"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Creating…
                            </>
                        ) : (
                            "Create Database"
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
