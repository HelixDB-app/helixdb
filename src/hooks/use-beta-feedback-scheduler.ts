import { useEffect, useRef } from "react";
import { isBetaFeedbackPromptBlocked } from "@/lib/beta-feedback-storage";

const ACTIVE_MS = 10 * 60 * 1000;
const IDLE_MS = 60 * 1000;
const TICK_MS = 2000;

export interface UseBetaFeedbackSchedulerOptions {
  userId: string | null;
  enabled: boolean;
  /** When true, active time does not accumulate (e.g. survey modal open). */
  paused: boolean;
  onEligible: () => void;
}

/**
 * Accumulates "active" time while the document is visible and the user has
 * interacted recently; fires onEligible once after ~10 minutes.
 */
export function useBetaFeedbackScheduler({
  userId,
  enabled,
  paused,
  onEligible,
}: UseBetaFeedbackSchedulerOptions): void {
  const accumulatedRef = useRef(0);
  const lastActivityRef = useRef(0);
  const lastTickRef = useRef(0);
  const firedRef = useRef(false);
  const onEligibleRef = useRef(onEligible);

  useEffect(() => {
    onEligibleRef.current = onEligible;
  }, [onEligible]);

  useEffect(() => {
    accumulatedRef.current = 0;
    lastTickRef.current = 0;
    firedRef.current = false;
    lastActivityRef.current = Date.now();
  }, [userId]);

  useEffect(() => {
    if (!enabled || paused) return;
    if (isBetaFeedbackPromptBlocked()) return;

    const bumpActivity = () => {
      lastActivityRef.current = Date.now();
    };
    bumpActivity();

    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", bumpActivity, opts);
    window.addEventListener("keydown", bumpActivity);
    window.addEventListener("scroll", bumpActivity, opts);

    lastTickRef.current = Date.now();
    const id = window.setInterval(() => {
      if (isBetaFeedbackPromptBlocked()) return;
      if (firedRef.current) return;

      const now = Date.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      if (document.visibilityState !== "visible") return;
      if (now - lastActivityRef.current > IDLE_MS) return;

      accumulatedRef.current += delta;
      if (accumulatedRef.current >= ACTIVE_MS) {
        firedRef.current = true;
        onEligibleRef.current();
      }
    }, TICK_MS);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("pointerdown", bumpActivity);
      window.removeEventListener("keydown", bumpActivity);
      window.removeEventListener("scroll", bumpActivity);
    };
  }, [enabled, paused, userId]);
}
