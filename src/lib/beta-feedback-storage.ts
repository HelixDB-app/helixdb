const LOCAL_KEY = "helix_beta_feedback_v1";
const SESSION_SKIP_KEY = "helix_beta_feedback_skip_session";

export type BetaFeedbackLocalState = "forever" | "submitted";

export function isBetaFeedbackPromptBlocked(): boolean {
  if (typeof window === "undefined") return true;
  if (sessionStorage.getItem(SESSION_SKIP_KEY) === "1") return true;
  const v = localStorage.getItem(LOCAL_KEY);
  return v === "forever" || v === "submitted";
}

export function markBetaFeedbackSubmitted(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_KEY, "submitted");
}

export function markBetaFeedbackDismissForever(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_KEY, "forever");
}

export function markBetaFeedbackNotNowSession(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(SESSION_SKIP_KEY, "1");
}
