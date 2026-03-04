"use client";

import { useEffect, useState } from "react";
import { useTrialStore } from "@/stores/trial-store";
import { useAuthStore } from "@/stores/auth-store";
import { authOpenBrowser } from "@/lib/tauri";
import { X, Timer, Zap, AlertTriangle, Shield } from "lucide-react";

function isTauri(): boolean {
    return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

// ─── Trial Expired Full-Screen Gate ──────────────────────────────────────────

export function TrialExpiredGate() {
    const { isAuthenticated } = useAuthStore();

    if (isAuthenticated) return null;

    return (
        <div className="fixed inset-0 z-[9000] flex flex-col items-center justify-center bg-background/98 backdrop-blur-md p-6">
            <div className="w-full max-w-md text-center space-y-6">
                {/* Icon */}
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
                    <Timer className="h-8 w-8 text-amber-400" />
                </div>

                {/* Headline */}
                <div className="space-y-2">
                    <h1 className="text-2xl font-bold tracking-tight">Your Free Trial Has Ended</h1>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                        You&apos;ve used your complimentary trial period. To continue using pgStudio,
                        please sign in and choose a subscription plan.
                    </p>
                </div>

                {/* CTA */}
                <div className="space-y-3">
                    <button
                        onClick={() => authOpenBrowser(`${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "http://localhost:3001"}/login`)}
                        className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                    >
                        <Zap className="h-4 w-4" />
                        Sign In &amp; Upgrade
                    </button>
                    <button
                        onClick={() => authOpenBrowser(`${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "http://localhost:3001"}/pricing`)}
                        className="w-full h-11 rounded-xl border border-border/60 text-muted-foreground text-sm hover:border-border hover:text-foreground transition-colors"
                    >
                        View Pricing Plans
                    </button>
                </div>

                {/* Trust line */}
                <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70">
                    <Shield className="h-3 w-3" />
                    <span>Secure payment powered by Stripe</span>
                </div>
            </div>
        </div>
    );
}

// ─── Active Trial Top Banner ──────────────────────────────────────────────────

export function TrialBanner() {
    const { result, isTrialActive, daysRemaining, loadState } = useTrialStore();
    const { isAuthenticated } = useAuthStore();
    const [dismissed, setDismissed] = useState(false);

    // Don't show if: user is authenticated, trial data isn't ready, or not in Tauri
    if (!isTauri()) return null;
    if (isAuthenticated) return null;
    if (loadState !== "ready") return null;
    if (!result) return null;
    if (!isTrialActive()) return null;
    if (dismissed) return null;

    const days = daysRemaining();
    const isUrgent = days <= 1;
    const isWarning = days <= 2;

    const bannerColor = isUrgent
        ? "from-red-500/10 via-red-500/5 to-transparent border-red-500/20 text-red-400"
        : isWarning
        ? "from-amber-500/10 via-amber-500/5 to-transparent border-amber-500/20 text-amber-400"
        : "from-emerald-500/10 via-emerald-500/5 to-transparent border-emerald-500/20 text-emerald-400";

    const badgeColor = isUrgent
        ? "bg-red-500/15 text-red-400 border-red-500/30"
        : isWarning
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
        : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";

    return (
        <div
            className={`
                fixed top-0 left-0 right-0 z-[8000]
                flex items-center justify-between gap-3
                bg-gradient-to-r ${bannerColor}
                border-b px-4 h-9
                backdrop-blur-sm
            `}
        >
            {/* Left: Icon + message */}
            <div className="flex items-center gap-2 min-w-0">
                {isUrgent || isWarning ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                    <Timer className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="text-xs font-medium truncate">
                    Free Trial
                </span>
                <span
                    className={`
                        hidden sm:inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium
                        ${badgeColor}
                    `}
                >
                    {days === 0
                        ? "Expires today"
                        : days === 1
                        ? "1 day remaining"
                        : `${days} days remaining`}
                </span>
            </div>

            {/* Right: CTA + dismiss */}
            <div className="flex items-center gap-2 shrink-0">
                <button
                    onClick={() => authOpenBrowser(`${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "http://localhost:3001"}/pricing`)}
                    className="
                        hidden sm:flex items-center gap-1.5 rounded-lg border border-current/30
                        px-2.5 py-1 text-[11px] font-semibold
                        hover:bg-current/10 transition-colors
                    "
                >
                    <Zap className="h-3 w-3" />
                    Upgrade Now
                </button>
                <button
                    onClick={() => setDismissed(true)}
                    className="rounded p-0.5 hover:bg-white/10 transition-colors"
                    aria-label="Dismiss trial banner"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

// ─── Trial Provider — initialises trial on mount ──────────────────────────────

export function TrialProvider({ children }: { children: React.ReactNode }) {
    const { initTrial, startPolling, loadState } = useTrialStore();
    const { isAuthenticated } = useAuthStore();

    useEffect(() => {
        if (!isTauri()) return;

        // Initialize trial on first load
        if (loadState === "idle") {
            initTrial().then(() => {
                startPolling();
            });
        }
    }, [initTrial, loadState, startPolling]);

    return <>{children}</>;
}

// ─── Trial Status Indicator (for profile panel / sidebar) ─────────────────────

export function TrialStatusBadge() {
    const { result, isTrialActive, daysRemaining, loadState } = useTrialStore();
    const { isAuthenticated } = useAuthStore();

    if (!isTauri() || isAuthenticated || loadState !== "ready" || !result) return null;

    if (isTrialActive()) {
        const days = daysRemaining();
        const isUrgent = days <= 1;
        return (
            <div
                className={`
                    flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium
                    ${isUrgent
                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }
                `}
            >
                <Timer className="h-3 w-3" />
                {days === 0 ? "Expires today" : days === 1 ? "1 day left" : `${days} days left`}
            </div>
        );
    }

    if (result.trial?.state === "expired" || result.trial?.state === "blocked") {
        return (
            <div className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium bg-red-500/10 text-red-400 border-red-500/20">
                <AlertTriangle className="h-3 w-3" />
                Trial Expired
            </div>
        );
    }

    return null;
}
