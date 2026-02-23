"use client";

import type { NotificationPayload } from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface InAppNotificationToastProps {
  payload: NotificationPayload;
  onDismiss?: () => void;
}

/**
 * In-app notification card: app logo, title, body, optional image.
 * Matches system notification content for consistent UX.
 */
export function InAppNotificationToast({
  payload,
  onDismiss,
}: InAppNotificationToastProps) {
  const title = payload.title ?? "Notification";
  const body = payload.body ?? "";
  const image = payload.image;

  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border border-border/50 bg-card/95 p-3 shadow-lg backdrop-blur-sm",
        "min-w-[280px] max-w-[360px]"
      )}
    >
      <div className="shrink-0">
        <img
          src="/logo.png"
          alt=""
          className="h-10 w-10 rounded-lg object-contain"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground truncate">
          {title}
        </p>
        {body ? (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {body}
          </p>
        ) : null}
        {image ? (
          <img
            src={image}
            alt=""
            className="mt-2 rounded-md object-cover max-h-20 w-full"
          />
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/50"
          aria-label="Dismiss"
        >
          <span className="text-xs font-medium">×</span>
        </button>
      ) : null}
    </div>
  );
}
