"use client";

import { ArrowUpRight, Loader2, Sparkles, X } from "lucide-react";
import { useUpdateStore } from "@/stores/update-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { APP_NAME } from "@/lib/app-config";

export function AppUpdateModal() {
  const {
    modalOpen,
    setModalOpen,
    latestVersion,
    currentVersion,
    openingStore,
    status,
    openAppStore,
  } = useUpdateStore();

  if (!modalOpen) return null;

  const showChecking = status === "checking";

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/40 bg-gradient-to-r from-primary/10 via-transparent to-transparent">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Update available</h2>
              <p className="text-xs text-muted-foreground">
                A new version of {APP_NAME} is ready in the App Store.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(false)}
            className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {currentVersion && (
              <Badge variant="secondary" className="font-mono">
                Installed v{currentVersion}
              </Badge>
            )}
            {latestVersion && (
              <Badge className="font-mono">New v{latestVersion}</Badge>
            )}
            {showChecking && (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking App Store…
              </span>
            )}
          </div>

          <div className="rounded-xl border border-border/40 bg-muted/30 p-4 text-xs text-muted-foreground space-y-2">
            <p className="font-medium text-foreground/90">How to update</p>
            <ol className="space-y-1.5">
              <li>1. Click “Update Now” to open the Mac App Store.</li>
              <li>2. Install the update and relaunch {APP_NAME}.</li>
              <li>3. We’ll show you what’s new after the update.</li>
            </ol>
          </div>
        </div>

        <div className="px-6 pb-6 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setModalOpen(false)}>
            Later
          </Button>
          <Button size="sm" onClick={() => void openAppStore()} disabled={openingStore} className="gap-2">
            {openingStore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            Update Now
          </Button>
        </div>
      </div>
    </div>
  );
}
