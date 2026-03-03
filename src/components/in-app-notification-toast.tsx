"use client";

import { useState } from "react";
import type { NotificationPayload } from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface InAppNotificationToastProps {
    payload: NotificationPayload;
    onDismiss?: () => void;
    /** Duration in ms — used to animate the progress bar. Default 7000 */
    duration?: number;
}

/**
 * macOS-style notification banner.
 * Shows app icon, title, body, optional image, optional action button.
 * Includes a depleting progress bar and dismiss button.
 */
export function InAppNotificationToast({
    payload,
    onDismiss,
    duration = 7000,
}: InAppNotificationToastProps) {
    const title = payload.title ?? "Notification";
    const body = payload.body ?? "";
    const image = payload.image;
    const actionUrl = payload.data?.actionUrl as string | undefined;

    const [imgError, setImgError] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    function handleDismiss() {
        setDismissed(true);
        setTimeout(() => onDismiss?.(), 200);
    }

    function handleOpen() {
        if (actionUrl) {
            try {
                window.open(actionUrl, "_blank", "noopener,noreferrer");
            } catch {
                // ignore
            }
        }
        handleDismiss();
    }

    if (dismissed) return null;

    return (
        <div
            className={cn(
                "group relative flex flex-col overflow-hidden",
                "w-[340px] max-w-[calc(100vw-1.5rem)]",
                "rounded-xl border border-white/[0.08] bg-[#1c1c1e]/96 shadow-2xl backdrop-blur-xl",
                "ring-1 ring-inset ring-white/[0.04]",
                "transition-all duration-200 ease-out",
                actionUrl && "cursor-pointer",
            )}
            onClick={actionUrl ? handleOpen : undefined}
        >
            {/* ── Header ── */}
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                <img
                    src="/logo.png"
                    alt="pgStudio"
                    className="h-4 w-4 rounded-[4px] object-contain shrink-0"
                />
                <span className="flex-1 text-[10px] font-medium uppercase tracking-widest text-white/40">
                    pgStudio
                </span>
                <span className="text-[10px] text-white/30">now</span>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
                    className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/40 opacity-0 transition-opacity hover:bg-white/[0.14] hover:text-white/70 group-hover:opacity-100"
                    aria-label="Dismiss"
                >
                    <svg viewBox="0 0 8 8" className="h-2.5 w-2.5" fill="currentColor">
                        <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>
            </div>

            {/* ── Content ── */}
            <div className="px-3 pb-2">
                <p className="text-[13px] font-semibold leading-snug text-white/95 truncate">
                    {title}
                </p>
                {body ? (
                    <p className="mt-0.5 text-[12px] leading-relaxed text-white/55 line-clamp-2">
                        {body}
                    </p>
                ) : null}
            </div>

            {/* ── Image ── */}
            {image && !imgError ? (
                <div className="mx-3 mb-2.5 overflow-hidden rounded-lg border border-white/[0.06]">
                    <img
                        src={image}
                        alt=""
                        className="max-h-[140px] w-full object-cover"
                        onError={() => setImgError(true)}
                        loading="eager"
                        decoding="async"
                    />
                </div>
            ) : null}

            {/* ── Action button ── */}
            {actionUrl ? (
                <div className="px-3 pb-2.5">
                    <div className="flex items-center gap-1 text-[11px] font-medium text-blue-400/90">
                        <span>Open</span>
                        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 6h8M6 2l4 4-4 4" />
                        </svg>
                    </div>
                </div>
            ) : null}

            {/* ── Progress bar ── */}
            <div className="h-[2px] w-full bg-white/[0.04]">
                <div
                    className="h-full bg-white/20 origin-left"
                    style={{
                        animation: `notification-progress ${duration}ms linear forwards`,
                    }}
                />
            </div>

            <style>{`
                @keyframes notification-progress {
                    from { transform: scaleX(1); }
                    to   { transform: scaleX(0); }
                }
            `}</style>
        </div>
    );
}
