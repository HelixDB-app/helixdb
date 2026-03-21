"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useSubscriptionStore } from "@/stores/subscription-store";
import {
    authDeleteToken,
    authOpenBrowser,
    authFetchPlans,
    authCreateCheckout,
    type PlanInfo,
} from "@/lib/tauri";
import { isTauriRuntime } from "@/lib/runtime";
import { getWebAppBaseUrl } from "@/lib/web-app-url";
import {
    Dialog,
    DialogContent,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
    LogOut,
    ExternalLink,
    User,
    Mail,
    Shield,
    Calendar,
    Loader2,
    Crown,
    MessageSquare,
    Zap,
    AlertCircle,
    CheckCircle2,
    Clock,
    ChevronLeft,
    Check,
} from "lucide-react";

function getInitials(name: string) {
    return name
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("");
}

function providerLabel(provider: string) {
    switch (provider) {
        case "google": return "Google";
        case "apple": return "Apple";
        default: return "Email";
    }
}

function ProviderIcon({ provider }: { provider: string }) {
    if (provider === "google") {
        return (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
        );
    }
    return <Shield className="h-3.5 w-3.5 text-muted-foreground" />;
}

function SubscriptionStatusBadge({ status }: { status: string }) {
    switch (status) {
        case "active":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/25">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Active
                </span>
            );
        case "expired":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive border border-destructive/25">
                    Expired
                </span>
            );
        case "cancelled":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground border border-border/30">
                    Cancelled
                </span>
            );
        default:
            return null;
    }
}

function formatPrice(cents: number, currency: string) {
    if (cents === 0) return "Free";
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: 0,
    }).format(cents / 100);
}

interface ProfilePanelProps {
    open: boolean;
    onClose: () => void;
}

export function ProfilePanel({ open, onClose }: ProfilePanelProps) {
    const { user, logout } = useAuthStore();
    const { subscription, isLoading: subLoading, startPolling, stopPolling, reset: resetSub } = useSubscriptionStore();
    const [loggingOut, setLoggingOut] = useState(false);
    const [view, setView] = useState<"profile" | "plans">("profile");
    const [plans, setPlans] = useState<PlanInfo[]>([]);
    const [plansLoading, setPlansLoading] = useState(false);
    const [checkoutLoadingId, setCheckoutLoadingId] = useState<string | null>(null);
    const [checkoutError, setCheckoutError] = useState<string | null>(null);

    useEffect(() => {
        if (open && user) {
            startPolling();
        }
        if (!open) {
            stopPolling();
            setView("profile");
            setCheckoutError(null);
        }
    }, [open, user, startPolling, stopPolling]);

    const loadPlans = useCallback(async () => {
        setPlansLoading(true);
        setCheckoutError(null);
        try {
            const data = await authFetchPlans();
            setPlans(data.filter((p) => p.price > 0));
        } catch {
            setCheckoutError("Failed to load plans. Please try again.");
        } finally {
            setPlansLoading(false);
        }
    }, []);

    async function handleShowPlans() {
        setView("plans");
        if (plans.length === 0) await loadPlans();
    }

    async function handleCheckout(planId: string) {
        setCheckoutLoadingId(planId);
        setCheckoutError(null);
        try {
            const url = await authCreateCheckout(planId);
            await authOpenBrowser(url);
        } catch (err) {
            setCheckoutError(err instanceof Error ? err.message : "Checkout failed. Please try again.");
        } finally {
            setCheckoutLoadingId(null);
        }
    }

    if (!user) return null;

    const joinDate = new Date(user.createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });

    const expiryDate = subscription?.endDate
        ? new Date(subscription.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : null;

    const daysLeft = subscription?.endDate
        ? Math.max(0, Math.ceil((new Date(subscription.endDate).getTime() - Date.now()) / 86400000))
        : 0;

    async function handleLogout() {
        setLoggingOut(true);
        // Clear UI state immediately so the header updates at once
        logout();
        resetSub();
        onClose();
        try {
            if (isTauriRuntime()) {
                await authDeleteToken();
            }
        } catch {
            // keychain deletion is best-effort; the in-memory state is already cleared
        } finally {
            setLoggingOut(false);
        }
    }

    async function handleEditProfile() {
        await authOpenBrowser(`${getWebAppBaseUrl()}/profile`);
    }

    const discordAccess = subscription?.discordAccess;
    const discordLabel = discordAccess === "2days" ? "2-Day Discord Access" : discordAccess === "4days" ? "4-Day Discord Access" : null;

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="max-w-[340px] p-0 gap-0 overflow-hidden border-border/40 shadow-2xl">

                {/* ── Plans view ──────────────────────────────────────────── */}
                {view === "plans" && (
                    <div className="p-5">
                        <div className="flex items-center gap-2 mb-4">
                            <button
                                onClick={() => { setView("profile"); setCheckoutError(null); }}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <h2 className="text-sm font-semibold">Choose a plan</h2>
                        </div>

                        {checkoutError && (
                            <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                {checkoutError}
                            </div>
                        )}

                        {plansLoading ? (
                            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-xs">Loading plans…</span>
                            </div>
                        ) : plans.length === 0 ? (
                            <div className="text-center py-8">
                                <p className="text-xs text-muted-foreground mb-3">No plans available.</p>
                                <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={loadPlans}>
                                    Retry
                                </Button>
                            </div>
                        ) : (
                            <div className="space-y-2.5">
                                {plans.map((plan) => (
                                    <div
                                        key={plan.id}
                                        className={`relative rounded-xl border p-3.5 transition-all ${plan.isFeatured ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/30 bg-muted/10"}`}
                                    >
                                        {plan.isFeatured && (
                                            <div className="absolute -top-2 left-3">
                                                <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[9px] font-bold text-white">
                                                    {plan.promoTag ?? "POPULAR"}
                                                </span>
                                            </div>
                                        )}
                                        <div className="flex items-start justify-between gap-2 mt-1">
                                            <div>
                                                <p className="text-sm font-semibold">{plan.name}</p>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                                    {plan.durationDays}-day access
                                                    {plan.discordAccess !== "none" && ` · Discord`}
                                                </p>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className={`text-base font-bold tabular-nums ${plan.isFeatured ? "text-emerald-400" : ""}`}>
                                                    {formatPrice(plan.price, plan.currency)}
                                                </p>
                                            </div>
                                        </div>
                                        <ul className="mt-2.5 space-y-1">
                                            {plan.features.slice(0, 3).map((f, i) => (
                                                <li key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                    <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                                                    {f}
                                                </li>
                                            ))}
                                            {plan.features.length > 3 && (
                                                <li className="text-[11px] text-muted-foreground/50 pl-4.5">
                                                    +{plan.features.length - 3} more
                                                </li>
                                            )}
                                        </ul>
                                        <Button
                                            size="sm"
                                            className={`mt-3 w-full gap-1.5 text-xs h-7 ${plan.isFeatured ? "bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-sm shadow-emerald-500/20" : ""}`}
                                            variant={plan.isFeatured ? "default" : "outline"}
                                            onClick={() => handleCheckout(plan.id)}
                                            disabled={checkoutLoadingId !== null}
                                        >
                                            {checkoutLoadingId === plan.id ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <ExternalLink className="h-3 w-3" />
                                            )}
                                            {checkoutLoadingId === plan.id ? "Opening checkout…" : "Subscribe · Pay with Stripe"}
                                        </Button>
                                    </div>
                                ))}
                                <p className="text-center text-[10px] text-muted-foreground/40 pt-1">
                                    Payments secured by Stripe
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Profile view ────────────────────────────────────────── */}
                {view === "profile" && <>
                {/* Gradient header */}
                <div className="relative h-20 bg-gradient-to-br from-emerald-500/20 via-cyan-500/10 to-transparent overflow-hidden">
                    <div className="absolute -top-8 -right-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
                    <div className="absolute -bottom-4 left-8 h-16 w-16 rounded-full bg-cyan-500/10 blur-xl" />
                </div>

                <div className="-mt-10 px-5 pb-5">
                    {/* Avatar row */}
                    <div className="flex items-end justify-between mb-4">
                        <div className="relative">
                            <Avatar className="h-16 w-16 ring-4 ring-background shadow-xl">
                                <AvatarImage src={user.image ?? undefined} alt={user.name} />
                                <AvatarFallback className="text-base font-bold bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 text-emerald-400">
                                    {getInitials(user.name)}
                                </AvatarFallback>
                            </Avatar>
                            {/* Provider indicator dot */}
                            <div className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background ring-2 ring-background shadow-sm">
                                <ProviderIcon provider={user.provider} />
                            </div>
                        </div>
                        <Badge variant="outline" className="text-[10px] h-5 px-2 border-border/40 bg-muted/20 text-muted-foreground font-normal mb-2">
                            {providerLabel(user.provider)}
                        </Badge>
                    </div>

                    {/* Name & email */}
                    <div className="mb-4 space-y-0.5">
                        <h2 className="text-[15px] font-semibold leading-tight tracking-tight">{user.name}</h2>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>

                    {/* Info pills */}
                    <div className="flex flex-wrap gap-2 mb-4">
                        <div className="flex items-center gap-1.5 rounded-lg border border-border/25 bg-muted/20 px-2.5 py-1.5">
                            <Calendar className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                            <span className="text-[11px] text-muted-foreground">Joined {joinDate}</span>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-lg border border-border/25 bg-muted/20 px-2.5 py-1.5">
                            <Mail className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                            <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">{user.email}</span>
                        </div>
                    </div>

                    <Separator className="mb-4 bg-border/25" />

                    {/* Subscription section */}
                    <div className="mb-4">
                        <div className="flex items-center gap-1.5 mb-2.5">
                            <Crown className="h-3.5 w-3.5 text-amber-400/80" />
                            <span className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                                Subscription
                            </span>
                        </div>

                        {subLoading && !subscription ? (
                            <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/15 px-3 py-3">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/40" />
                                <span className="text-xs text-muted-foreground/50">Loading…</span>
                            </div>
                        ) : subscription ? (
                            <div className="rounded-xl border border-border/30 bg-muted/10 overflow-hidden">
                                {/* Plan name + status */}
                                <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20">
                                    <div className="flex items-center gap-2">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/15">
                                            <Crown className="h-3 w-3 text-amber-400" />
                                        </div>
                                        <span className="text-sm font-semibold">{subscription.planName}</span>
                                    </div>
                                    <SubscriptionStatusBadge status={subscription.status} />
                                </div>

                                {subscription.status === "active" && (
                                    <div className="px-3 py-2.5 space-y-2">
                                        {expiryDate && (
                                            <div className="flex items-center justify-between text-[11px]">
                                                <div className="flex items-center gap-1.5 text-muted-foreground">
                                                    <Clock className="h-3 w-3 shrink-0" />
                                                    Expires {expiryDate}
                                                </div>
                                                <span className={`font-semibold tabular-nums ${daysLeft <= 5 ? "text-destructive" : "text-muted-foreground/70"}`}>
                                                    {daysLeft}d left
                                                </span>
                                            </div>
                                        )}
                                        {discordLabel && (
                                            <div className="flex items-center gap-1.5 text-[11px] text-indigo-400">
                                                <MessageSquare className="h-3 w-3 shrink-0" />
                                                {discordLabel}
                                            </div>
                                        )}
                                        {daysLeft <= 3 && daysLeft > 0 && (
                                            <div className="flex items-center gap-1.5 rounded-lg bg-destructive/10 border border-destructive/20 px-2.5 py-1.5 text-[11px] text-destructive">
                                                <AlertCircle className="h-3 w-3 shrink-0" />
                                                Expiring soon — renew to keep access
                                            </div>
                                        )}
                                    </div>
                                )}

                                {subscription.status === "active" && daysLeft === 0 && (
                                    <div className="flex items-center gap-1.5 rounded-b-xl bg-destructive/10 border-t border-destructive/20 px-3 py-2 text-[11px] text-destructive">
                                        <AlertCircle className="h-3 w-3 shrink-0" />
                                        Subscription expired today
                                    </div>
                                )}

                                {(subscription.status === "expired" || subscription.status === "cancelled") && (
                                    <div className="px-3 py-2.5">
                                        <p className="text-[11px] text-muted-foreground">
                                            {subscription.status === "expired"
                                                ? "Your subscription has expired."
                                                : "Subscription was cancelled."}
                                        </p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={handleShowPlans}
                                className="group w-full flex items-center gap-3 rounded-xl border border-dashed border-border/30 bg-muted/10 px-3 py-3 text-left transition-all hover:border-emerald-500/30 hover:bg-emerald-500/5"
                            >
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/30 group-hover:bg-emerald-500/15 transition-colors">
                                    <Crown className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-emerald-400 transition-colors" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-muted-foreground/70 group-hover:text-foreground/80 transition-colors">No active subscription</p>
                                    <p className="text-[10px] text-muted-foreground/40 group-hover:text-emerald-400/70 transition-colors">Click to view plans →</p>
                                </div>
                            </button>
                        )}
                    </div>

                    {/* Actions */}
                    <div className="space-y-2">
                        {(!subscription || subscription.status !== "active") && (
                            <Button
                                size="sm"
                                className="w-full gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-sm shadow-emerald-500/20"
                                onClick={handleShowPlans}
                            >
                                <Zap className="h-3.5 w-3.5" />
                                {subscription ? "Renew Subscription" : "Subscribe Now"}
                            </Button>
                        )}
                        {subscription?.status === "active" && daysLeft <= 5 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full gap-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                                onClick={handleShowPlans}
                            >
                                <Zap className="h-3.5 w-3.5" />
                                Renew Early
                            </Button>
                        )}
                        {subscription?.status === "active" && daysLeft > 5 && (
                            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                All features unlocked · {daysLeft} days remaining
                            </div>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full gap-2 border-border/30 text-muted-foreground hover:text-foreground"
                            onClick={handleEditProfile}
                        >
                            <User className="h-3.5 w-3.5" />
                            Edit Profile
                            <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full gap-2 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10"
                            onClick={handleLogout}
                            disabled={loggingOut}
                        >
                            {loggingOut ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <LogOut className="h-3.5 w-3.5" />
                            )}
                            {loggingOut ? "Signing out…" : "Sign Out"}
                        </Button>
                    </div>

                    {/* Backend indicator */}
                    <p className="mt-3 text-center text-[10px] text-muted-foreground/30 select-none">
                        Connected via {process.env.NEXT_PUBLIC_WEB_APP_URL}
                    </p>
                </div>
                </>}
            </DialogContent>
        </Dialog>
    );
}
