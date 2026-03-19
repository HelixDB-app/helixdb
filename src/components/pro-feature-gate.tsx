"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useSubscriptionStore, type SubscriptionStatus } from "@/stores/subscription-store";
import { useTrialStore } from "@/stores/trial-store";
import { authOpenBrowser } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { track } from "@/lib/analytics";

export function hasProAccess(subscription: SubscriptionStatus | null): boolean {
  return subscription?.status === "active";
}

export function ProFeatureGate({
  featureKey,
  title,
  description,
  children,
}: {
  featureKey: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const { isAuthenticated } = useAuthStore();
  const { subscription } = useSubscriptionStore();
  const { isTrialActive } = useTrialStore();

  const allowed = (isAuthenticated && hasProAccess(subscription)) || isTrialActive();

  useEffect(() => {
    if (!allowed) void track("feature_gate_shown", { feature: featureKey });
  }, [allowed, featureKey]);

  if (allowed) return <>{children}</>;

  return (
    <Card className="p-5">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            void track("upgrade_click", { feature: featureKey });
            authOpenBrowser(
              `${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app"}/pricing`
            );
          }}
        >
          Upgrade
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            authOpenBrowser(
              `${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app"}/login`
            );
          }}
        >
          Sign in
        </Button>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/70">
        This gate is intentionally simple for private beta pricing tests. Attach it to advanced workflows only.
      </p>
    </Card>
  );
}
