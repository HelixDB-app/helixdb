"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface DbInfrastructureErrorStateProps {
    /** Short heading (e.g. "Couldn't reach the database"). */
    headline: string;
    /** User-facing explanation. */
    description: string;
    /** Optional secondary line (e.g. how to fix). */
    hint?: string;
    /** Raw error for "Technical details" (optional). */
    technicalMessage?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
    retryLabel?: string;
    className?: string;
    /** Tighter layout when embedded in a small panel. */
    compact?: boolean;
}

export function DbInfrastructureErrorState({
    headline,
    description,
    hint,
    technicalMessage,
    onRetry,
    isRetrying = false,
    retryLabel = "Retry",
    className,
    compact = false,
}: DbInfrastructureErrorStateProps) {
    const [showTechnical, setShowTechnical] = useState(false);
    const tech = technicalMessage?.trim();

    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-4 py-6 sm:px-8",
                className
            )}
        >
            <div
                className={cn(
                    "relative w-full max-w-lg rounded-2xl border border-border/40 bg-gradient-to-b from-muted/30 via-background to-background p-6 shadow-lg sm:p-8",
                    "ring-1 ring-black/[0.03] dark:ring-white/[0.06]"
                )}
            >
                <div
                    className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 h-32 rounded-t-2xl bg-gradient-to-b from-orange-500/[0.07] via-transparent to-transparent",
                        "dark:from-orange-400/[0.09]"
                    )}
                    aria-hidden
                />

                <div className="relative flex flex-col items-center text-center">
                    <div
                        className={cn(
                            "relative mb-5 overflow-hidden rounded-xl bg-muted/20",
                            compact ? "max-h-[min(28vh,200px)] w-full max-w-[280px]" : "max-h-[min(40vh,280px)] w-full max-w-[320px]"
                        )}
                    >
                        <Image
                            src="/dberror.png"
                            alt="Stylized illustration of a database connection failure"
                            width={640}
                            height={400}
                            className="h-auto w-full object-contain object-center"
                            priority={false}
                            sizes="(max-width: 640px) 100vw, 320px"
                        />
                    </div>

                    <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">{headline}</h2>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
                    {hint ? (
                        <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground/90">{hint}</p>
                    ) : null}

                    {onRetry && (
                        <Button
                            type="button"
                            size="sm"
                            className="mt-6 h-9 gap-2 px-5 font-medium shadow-sm"
                            disabled={isRetrying}
                            onClick={onRetry}
                        >
                            {isRetrying ? (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                            ) : (
                                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                            )}
                            {isRetrying ? "Retrying…" : retryLabel}
                        </Button>
                    )}

                    {tech && (
                        <div className="mt-6 w-full border-t border-border/30 pt-4 text-left">
                            <button
                                type="button"
                                onClick={() => setShowTechnical((v) => !v)}
                                className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <ChevronDown
                                    className={cn("h-3.5 w-3.5 shrink-0 transition-transform", showTechnical && "rotate-180")}
                                    aria-hidden
                                />
                                {showTechnical ? "Hide" : "Show"} technical details
                            </button>
                            {showTechnical && (
                                <ScrollArea className="mt-2 max-h-40 rounded-lg border border-border/40 bg-muted/25 p-3">
                                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/85">
                                        {tech}
                                    </pre>
                                </ScrollArea>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
