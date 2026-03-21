import type { SurveyTokenGetter } from "@/lib/survey";

const WEB_BASE_URL =
  process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";

export const BETA_FEEDBACK_CATEGORIES = [
  "general",
  "idea",
  "bug",
  "feature",
] as const;

export type BetaFeedbackCategory = (typeof BETA_FEEDBACK_CATEGORIES)[number];

export interface SubmitBetaFeedbackPayload {
  message: string;
  category: BetaFeedbackCategory;
  contactEmail?: string;
  appVersion?: string;
  platform?: string;
  clientLocale?: string;
}

export interface BetaFeedbackOptions {
  getToken?: SurveyTokenGetter;
}

function headersWithToken(token: string | null): HeadersInit {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function resolveToken(getToken?: SurveyTokenGetter): Promise<string | null> {
  if (getToken) return getToken();
  if (typeof window !== "undefined") {
    return localStorage.getItem("pgstudio_jwt");
  }
  return null;
}

export async function submitBetaFeedback(
  payload: SubmitBetaFeedbackPayload,
  options?: BetaFeedbackOptions
): Promise<{ id: string }> {
  const token = await resolveToken(options?.getToken);
  const res = await fetch(`${WEB_BASE_URL}/api/feedback`, {
    method: "POST",
    headers: headersWithToken(token),
    body: JSON.stringify({
      message: payload.message,
      category: payload.category,
      ...(payload.contactEmail?.trim()
        ? { contactEmail: payload.contactEmail.trim() }
        : {}),
      ...(payload.appVersion ? { appVersion: payload.appVersion } : {}),
      ...(payload.platform ? { platform: payload.platform } : {}),
      ...(payload.clientLocale ? { clientLocale: payload.clientLocale } : {}),
    }),
  });

  const errJson = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      (errJson as { error?: string }).error ?? "Failed to send feedback"
    );
  }

  const data = errJson as { id?: string };
  return { id: data.id ?? "" };
}
