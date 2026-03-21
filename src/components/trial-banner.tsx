"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrialStore } from "@/stores/trial-store";
import { useAuthStore } from "@/stores/auth-store";
import {
    authFetchPlans,
    authOpenBrowser,
    authCreateCheckout,
    type PlanInfo,
} from "@/lib/tauri";
import { useDesktopAuthLogin } from "@/hooks/use-desktop-auth-login";
import { useCountdown } from "@/lib/use-countdown";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import {
    X,
    Timer,
    Zap,
    AlertTriangle,
    Shield,
    Crown,
    Check,
    Sparkles,
    Loader2,
    RefreshCw,
    AlertCircle,
    Wifi,
} from "lucide-react";

const WEB_APP_URL = process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";

// ─── Trial Expired Full-Screen Gate ──────────────────────────────────────────

export function TrialExpiredGate() {
    const { isAuthenticated } = useAuthStore();
    const [plans, setPlans] = useState<PlanInfo[]>([]);
    const [loadingPlans, setLoadingPlans] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);

    const refreshPlans = useCallback(() => {
        if (isAuthenticated) return;
        let cancelled = false;
        setLoadingPlans(true);
        setPlanError(null);
        authFetchPlans()
            .then((data) => {
                if (cancelled) return;
                setPlans(data.filter((p) => p.price > 0));
            })
            .catch((err) => {
                if (cancelled) return;
                setPlanError(err instanceof Error ? err.message : "Failed to load plans");
            })
            .finally(() => {
                if (!cancelled) setLoadingPlans(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated]);

    useEffect(() => refreshPlans(), [refreshPlans]);

    const planCards = useMemo(() => {
        if (plans.length === 0) return [];
        const sorted = [...plans].sort((a, b) => a.price - b.price);
        const featured = sorted.find((p) => p.isFeatured) ?? sorted[0];
        const annual = sorted.find((p) => p.durationDays >= 300 && p.id !== featured?.id);
        const secondary = annual ?? sorted.find((p) => p.id !== featured?.id) ?? null;
        return [featured, secondary].filter(Boolean) as PlanInfo[];
    }, [plans]);

    const annualSavings = useMemo(() => {
        const monthly = plans.find((p) => p.durationDays >= 28 && p.durationDays < 300);
        const annual = plans.find((p) => p.durationDays >= 300);
        if (!monthly || !annual) return null;
        const monthlyPerMonth = monthly.price;
        const annualPerMonth = annual.price / 12;
        const savings = Math.round((1 - annualPerMonth / monthlyPerMonth) * 100);
        return savings > 0 ? { annualId: annual.id, savings } : null;
    }, [plans]);

    const featuredPlanIdRef = useRef<string | null>(null);
    useEffect(() => {
        featuredPlanIdRef.current = planCards[0]?.id ?? null;
    }, [planCards]);

    const onSignedInOpenCheckout = useCallback(async () => {
        const planId = featuredPlanIdRef.current;
        try {
            if (planId) {
                const url = await authCreateCheckout(planId);
                await authOpenBrowser(url);
            } else {
                await authOpenBrowser(`${WEB_APP_URL}/pricing`);
            }
        } catch {
            await authOpenBrowser(`${WEB_APP_URL}/pricing`);
        }
        void useTrialStore.getState().refreshStatus();
    }, []);

    const {
        phase: authPhase,
        errorMsg: authErrorMsg,
        startLogin,
        cancel: cancelAuth,
        isActive: authActive,
    } = useDesktopAuthLogin({ onLoginSuccess: onSignedInOpenCheckout });

    function formatPrice(cents: number, currency: string) {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: currency.toUpperCase(),
            minimumFractionDigits: 0,
        }).format(cents / 100);
    }

    function cadenceLabel(days: number) {
        if (days >= 300) return "Annual";
        if (days >= 28) return "Monthly";
        return `${days}-day`;
    }

    if (isAuthenticated) return null;

    return (
        <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/98 backdrop-blur-md p-6">
            <div className="w-full max-w-3xl rounded-3xl border border-border/50 bg-card/95 shadow-2xl overflow-hidden">
                <div className="grid gap-6 p-6 md:grid-cols-[1.1fr_1fr]">
                    <div className="space-y-5">
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
                            <Timer className="h-6 w-6 text-amber-400" />
                        </div>
                        <div className="space-y-2">
                            <h1 className="text-2xl font-semibold tracking-tight">Your free trial has ended</h1>
                            <p className="text-sm text-muted-foreground leading-relaxed">
                                Upgrade to keep every pro workflow unlocked — AI tools, advanced analytics,
                                and collaboration features.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Sparkles className="h-3.5 w-3.5 text-primary" />
                                Immediate access after checkout
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Shield className="h-3.5 w-3.5 text-primary" />
                                Secure payments with Stripe
                            </div>
                        </div>

                        {authPhase === "timedout" && (
                            <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <span>
                                    No response from the browser. Finish signing in in the tab that opened, then{" "}
                                    <strong>retry</strong>.
                                </span>
                            </div>
                        )}
                        {authPhase === "error" && authErrorMsg && (
                            <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                {authErrorMsg}
                            </div>
                        )}
                        {authPhase === "waiting" && (
                            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                                <Wifi className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                                Browser opened — complete sign-in there. We&apos;ll open checkout when you return.
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                            {authActive ? (
                                <>
                                    <button
                                        type="button"
                                        disabled
                                        className="h-10 rounded-xl bg-primary/80 px-4 text-xs font-semibold text-primary-foreground flex items-center gap-2 cursor-wait opacity-90"
                                    >
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        {authPhase === "processing" ? "Signing in…" : "Waiting for browser…"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={cancelAuth}
                                        className="h-10 rounded-xl border border-border/60 px-4 text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
                                    >
                                        Cancel
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => void startLogin()}
                                        className="h-10 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-2"
                                    >
                                        {authPhase === "timedout" || authPhase === "error" ? (
                                            <RefreshCw className="h-4 w-4" />
                                        ) : (
                                            <Zap className="h-4 w-4" />
                                        )}
                                        {authPhase === "timedout" || authPhase === "error"
                                            ? "Retry sign in"
                                            : "Sign In & Upgrade"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => authOpenBrowser(`${WEB_APP_URL}/pricing`)}
                                        className="h-10 rounded-xl border border-border/60 px-4 text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
                                    >
                                        View All Plans
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="space-y-3">
                        {loadingPlans && (
                            <div className="rounded-2xl border border-border/40 bg-muted/20 p-4 animate-pulse">
                                <div className="h-4 w-24 rounded bg-muted/40" />
                                <div className="mt-3 h-6 w-32 rounded bg-muted/40" />
                                <div className="mt-4 space-y-2">
                                    <div className="h-3 w-40 rounded bg-muted/40" />
                                    <div className="h-3 w-32 rounded bg-muted/40" />
                                </div>
                            </div>
                        )}
                        {!loadingPlans && planError && (
                            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive space-y-3">
                                <p>{planError}</p>
                                <button
                                    onClick={refreshPlans}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-2.5 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                        {!loadingPlans && planCards.length > 0 && (
                            <div className="space-y-3">
                                {planCards.map((plan) => (
                                    <div key={plan.id} className="rounded-2xl border border-border/40 bg-muted/10 p-4">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-xs text-muted-foreground">{cadenceLabel(plan.durationDays)}</p>
                                                <p className="text-sm font-semibold">{plan.name}</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-base font-semibold text-foreground">
                                                    {formatPrice(plan.price, plan.currency)}
                                                </p>
                                                <p className="text-[10px] text-muted-foreground">
                                                    {plan.durationDays} days
                                                </p>
                                            </div>
                                        </div>
                                        <div className="mt-3 space-y-1.5 text-[11px] text-muted-foreground">
                                            {plan.features.slice(0, 3).map((feature) => (
                                                <div key={feature} className="flex items-center gap-2">
                                                    <Check className="h-3 w-3 text-emerald-400" />
                                                    <span>{feature}</span>
                                                </div>
                                            ))}
                                        </div>
                                        {plan.isFeatured && (
                                            <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                                                <Crown className="h-3 w-3" />
                                                Most popular
                                            </div>
                                        )}
                                        {annualSavings && plan.id === annualSavings.annualId && (
                                            <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                                                Save {annualSavings.savings}%
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Active Trial Top Banner ──────────────────────────────────────────────────

export function TrialBanner() {
    const { result, isTrialActive, loadState, refreshStatus } = useTrialStore();
    const { isAuthenticated } = useAuthStore();
    const [dismissed, setDismissed] = useState(false);
    const countdown = useCountdown(result?.trial?.trialExpiryDate);

    const showBanner =
        isTauriRuntime() &&
        !isAuthenticated &&
        loadState === "ready" &&
        result !== null &&
        isTrialActive() &&
        !dismissed &&
        !countdown.expired;

    useEffect(() => {
        if (countdown.expired && loadState === "ready") {
            void refreshStatus();
        }
    }, [countdown.expired, loadState, refreshStatus]);

    useEffect(() => {
        if (typeof document === "undefined") return;
        if (showBanner) {
            document.documentElement.setAttribute("data-trial-banner", "");
        } else {
            document.documentElement.removeAttribute("data-trial-banner");
        }
        return () => document.documentElement.removeAttribute("data-trial-banner");
    }, [showBanner]);

    if (!showBanner) return null;

    const hoursRemaining = Math.max(1, Math.ceil(countdown.totalMs / 3600000));
    const isUrgent = hoursRemaining <= 24;
    const isWarning = hoursRemaining <= 48;

    const pad = (value: number) => String(value).padStart(2, "0");
    const timeLabel = countdown.days > 0
        ? `${countdown.days}d ${pad(countdown.hours)}h ${pad(countdown.minutes)}m`
        : `${pad(countdown.hours)}:${pad(countdown.minutes)}:${pad(countdown.seconds)}`;

    const accentBorder = isUrgent
        ? "border-l-red-500/75"
        : isWarning
        ? "border-l-amber-500/70"
        : "border-l-emerald-500/55";

    const iconClass = isUrgent
        ? "text-red-400"
        : isWarning
        ? "text-amber-400"
        : "text-emerald-400";

    return (
        <div
            className={cn(
                "fixed top-0 left-0 right-0 z-[8000] flex h-10 items-center justify-between gap-3 border-b border-border/40",
                "bg-background/92 backdrop-blur-md pl-3 pr-2 sm:pl-4 sm:pr-3",
                "border-l-[3px]",
                accentBorder
            )}
            role="status"
            aria-live="polite"
        >
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
                {isUrgent || isWarning ? (
                    <AlertTriangle className={cn("h-3.5 w-3.5 shrink-0", iconClass)} aria-hidden />
                ) : (
                    <Timer className={cn("h-3.5 w-3.5 shrink-0", iconClass)} aria-hidden />
                )}
                <div className="flex min-w-0 flex-col gap-0 sm:flex-row sm:items-baseline sm:gap-2">
                    <span className="truncate text-xs font-medium text-foreground">
                        Pro trial — all features unlocked
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground sm:text-xs">
                        Ends in <span className="text-foreground/90">{timeLabel}</span>
                    </span>
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
                <button
                    type="button"
                    onClick={() => authOpenBrowser(`${WEB_APP_URL}/pricing`)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-gradient-to-r from-emerald-600 to-cyan-600 px-2.5 text-[11px] font-semibold text-white shadow-none transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                    <Zap className="h-3 w-3 opacity-90" aria-hidden />
                    <span className="hidden min-[400px]:inline">Upgrade</span>
                    <span className="min-[400px]:hidden">Pro</span>
                </button>
                <button
                    type="button"
                    onClick={() => setDismissed(true)}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    aria-label="Dismiss trial reminder"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

// ─── Trial Provider — initialises trial on mount ──────────────────────────────

export function TrialProvider({ children }: { children: React.ReactNode }) {
    const { initTrial, startPolling, loadState, refreshStatus, result } = useTrialStore();
    const { user } = useAuthStore();

    useEffect(() => {
        if (!isTauriRuntime()) return;

        // Initialize trial on first load
        if (loadState === "idle") {
            initTrial(user?.id).then(() => {
                startPolling();
            });
        }
    }, [initTrial, loadState, startPolling, user?.id]);

    useEffect(() => {
        if (!result?.trial?.trialExpiryDate) return;
        const expiry = new Date(result.trial.trialExpiryDate).getTime();
        if (Number.isNaN(expiry)) return;
        const delay = Math.max(0, expiry - Date.now() + 1500);
        const timeout = setTimeout(() => {
            void refreshStatus();
        }, delay);
        return () => clearTimeout(timeout);
    }, [result?.trial?.trialExpiryDate, refreshStatus]);

    return <>{children}</>;
}

// ─── Trial Gate (global) ─────────────────────────────────────────────────────

export function TrialGate() {
    const { result, loadState, isTrialActive } = useTrialStore();
    const { isAuthenticated } = useAuthStore();

    if (!isTauriRuntime()) return null;
    const expired = !isAuthenticated && loadState === "ready" && result && !isTrialActive();
    if (!expired) return null;

    return <TrialExpiredGate />;
}

// ─── Trial Status Indicator (for profile panel / sidebar) ─────────────────────

export function TrialStatusBadge() {
    const { result, isTrialActive, daysRemaining, loadState } = useTrialStore();
    const { isAuthenticated } = useAuthStore();

    if (!isTauriRuntime() || isAuthenticated || loadState !== "ready" || !result) return null;

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
