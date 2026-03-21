"use client";

import { useDesktopAuthLogin } from "@/hooks/use-desktop-auth-login";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogIn, Loader2, X, RefreshCw, AlertCircle, Wifi } from "lucide-react";

interface LoginPromptProps {
    /** Called after successful login */
    onLoginSuccess?: () => void;
    /** Called when user dismisses the prompt */
    onDismiss?: () => void;
    compact?: boolean;
}

export function LoginPrompt({ onLoginSuccess, onDismiss, compact = false }: LoginPromptProps) {
    const { isLoading: authLoading } = useAuthStore();
    const { phase, errorMsg, startLogin: handleLogin, cancel: handleCancel, isActive } =
        useDesktopAuthLogin({ onLoginSuccess });

    // ── Compact (header button) mode ─────────────────────────────────────────
    if (compact) {
        if (authLoading) {
            return <Skeleton className="h-7 w-16 rounded-md" />;
        }

        if (phase === "timedout") {
            return (
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground/70">Timed out</span>
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs h-7"
                        onClick={handleLogin}
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </Button>
                </div>
            );
        }

        if (phase === "error" && errorMsg) {
            return (
                <div className="flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs h-7"
                        onClick={handleLogin}
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </Button>
                </div>
            );
        }

        if (isActive) {
            return (
                <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs h-7"
                    onClick={handleCancel}
                >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {phase === "processing" ? "Signing in…" : "Waiting…"}
                    <X className="h-3 w-3 ml-0.5 opacity-50" />
                </Button>
            );
        }

        return (
            <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2.5 text-xs max-sm:w-7 max-sm:px-0 max-sm:[&>svg]:shrink-0"
                onClick={handleLogin}
                aria-label="Sign in"
            >
                <LogIn className="h-3.5 w-3.5" />
                <span className="max-sm:sr-only">Sign In</span>
            </Button>
        );
    }

    // ── Full (card) mode ─────────────────────────────────────────────────────
    return (
        <div className="rounded-xl border border-border/50 bg-card px-5 py-5 shadow-sm">
            <div className="flex items-start justify-between mb-3">
                <div>
                    <h3 className="text-sm font-semibold leading-tight">Sign in to pgStudio</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        Sync your profile and preferences across devices
                    </p>
                </div>
                {onDismiss && (
                    <button
                        className="ml-2 mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
                        onClick={onDismiss}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {phase === "timedout" && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 text-xs text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                        No response received from the browser.
                        Complete sign-in in the browser tab that opened, then click <strong>Retry</strong>.
                    </span>
                </div>
            )}
            {phase === "error" && errorMsg && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-2.5 py-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {errorMsg}
                </div>
            )}
            {phase === "waiting" && (
                <div className="mb-3 flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
                    <Wifi className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                    Browser opened — complete sign-in there, then return here.
                </div>
            )}

            {isActive ? (
                <div className="flex gap-2">
                    <Button size="sm" className="flex-1 gap-2" disabled>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {phase === "processing" ? "Signing in…" : "Waiting for browser…"}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2 px-3" onClick={handleCancel}>
                        <X className="h-3.5 w-3.5" />
                        Cancel
                    </Button>
                </div>
            ) : (
                <Button size="sm" className="w-full gap-2" onClick={handleLogin}>
                    {phase === "timedout" || phase === "error" ? (
                        <RefreshCw className="h-3.5 w-3.5" />
                    ) : (
                        <LogIn className="h-3.5 w-3.5" />
                    )}
                    {phase === "timedout" ? "Retry Sign In" : phase === "error" ? "Try Again" : "Sign In with Browser"}
                </Button>
            )}
        </div>
    );
}
