"use client";

import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useUpdateStore } from "@/stores/update-store";
import { APP_NAME, APP_VERSION } from "@/lib/app-config";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";

const CHANGELOG_URL = "https://pgstudio-web.vercel.app/changelog";

function GradientIconFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg",
        "bg-gradient-to-br from-violet-500 via-cyan-400 to-lime-400",
        "ring-2 ring-white/25 ring-offset-2 ring-offset-black/40",
        className
      )}
    >
      {children}
    </div>
  );
}

export function AppUpdateModal() {
  const {
    modalOpen,
    setModalOpen,
    latestVersion,
    currentVersion,
    openingStore,
    status,
    error,
    openAppStore,
    checkForUpdates,
  } = useUpdateStore();

  if (!modalOpen) return null;

  const versionLabel = currentVersion ?? APP_VERSION;

  const openChangelog = () => {
    if (!isTauriRuntime()) return;
    void open(CHANGELOG_URL);
  };

  const shell = (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-6 animate-in fade-in-0 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-update-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
        aria-label="Close"
        onClick={() => setModalOpen(false)}
      />
      <div
        className={cn(
          "relative w-full max-w-[400px] overflow-hidden rounded-[28px] text-center shadow-2xl",
          "border border-white/10 bg-gradient-to-b from-zinc-800/90 to-zinc-950/95 backdrop-blur-2xl",
          "dark:from-zinc-900/80 dark:to-black/90"
        )}
      >
        <button
          type="button"
          onClick={() => setModalOpen(false)}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Checking */}
        {status === "checking" && (
          <div className="px-8 pb-10 pt-12">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            </div>
            <h2
              id="app-update-title"
              className="text-lg font-semibold tracking-tight text-white"
            >
              Checking for updates
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              Contacting the App Store for the latest {APP_NAME} release…
            </p>
          </div>
        )}

        {/* Up to date */}
        {status === "up-to-date" && (
          <div className="px-8 pb-10 pt-12">
            <GradientIconFrame>
              <Check className="h-8 w-8 text-white drop-shadow-md" strokeWidth={2.5} />
            </GradientIconFrame>
            <h2
              id="app-update-title"
              className="mt-6 text-lg font-semibold tracking-tight text-white"
            >
              You&apos;re up to date
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">
              You are currently on the latest version:{" "}
              <span className="font-mono font-medium text-white">{versionLabel}</span>
              . We&apos;ll notify you when a new update is available.
            </p>
            {isTauriRuntime() && (
              <button
                type="button"
                onClick={() => void openChangelog()}
                className="mt-4 text-xs font-medium text-cyan-400/90 underline-offset-2 hover:text-cyan-300 hover:underline"
              >
                View release notes on the web
              </button>
            )}
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="mt-8 w-full rounded-full bg-[#0A84FF] py-3.5 text-sm font-semibold uppercase tracking-wide text-white shadow-lg shadow-blue-500/20 transition hover:bg-[#0077ED] active:scale-[0.98]"
            >
              OK
            </button>
          </div>
        )}

        {/* Update available */}
        {status === "available" && (
          <div className="px-8 pb-10 pt-12">
            <GradientIconFrame className="from-amber-400 via-orange-500 to-rose-500">
              <Sparkles className="h-8 w-8 text-white drop-shadow-md" />
            </GradientIconFrame>
            <h2
              id="app-update-title"
              className="mt-6 text-lg font-semibold tracking-tight text-white"
            >
              Update available
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              A new version of {APP_NAME} is ready in the Mac App Store.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-zinc-300">
                v{versionLabel}
              </span>
              {latestVersion && (
                <span className="rounded-full bg-emerald-500/20 px-3 py-1 font-mono text-xs font-medium text-emerald-300">
                  New v{latestVersion}
                </span>
              )}
            </div>
            <div className="mt-8 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void openAppStore()}
                disabled={openingStore}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-[#0A84FF] py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:bg-[#0077ED] disabled:opacity-60 active:scale-[0.98]"
              >
                {openingStore ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
                Update in App Store
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="w-full rounded-full py-3 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
              >
                Not now
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="px-8 pb-10 pt-12">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/15 ring-1 ring-red-400/30">
              <AlertCircle className="h-9 w-9 text-red-400" />
            </div>
            <h2
              id="app-update-title"
              className="text-lg font-semibold tracking-tight text-white"
            >
              Couldn&apos;t check for updates
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              {error ?? "Something went wrong. Please try again in a moment."}
            </p>
            <div className="mt-8 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void checkForUpdates({ source: "manual" })}
                className="w-full rounded-full bg-[#0A84FF] py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:bg-[#0077ED] active:scale-[0.98]"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="w-full rounded-full py-3 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return shell;
}
