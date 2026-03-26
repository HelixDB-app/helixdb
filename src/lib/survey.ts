import { getWebAppBaseUrl } from "@/lib/web-app-url";
import { getWebAccountJwt } from "@/lib/web-account-jwt";

const surveyApiBase = () => getWebAppBaseUrl();

export type SurveyTokenGetter = () => Promise<string | null>;

function headersWithToken(token: string | null): HeadersInit {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function resolveToken(getToken?: SurveyTokenGetter): Promise<string | null> {
  if (getToken) {
    const t = await getToken();
    if (t) return t;
  }
  if (typeof window !== "undefined") {
    const legacy = localStorage.getItem("pgstudio_jwt")?.trim();
    if (legacy) return legacy;
    return getWebAccountJwt();
  }
  return null;
}

export interface SurveyAnswers {
  howDidYouHear?: string;
  primaryReason?: string;
  userType?: string;
  featureInterest?: string;
  mainDatabase?: string;
}

/** Options for survey API calls. Optional `getToken` overrides default resolution (Tauri keychain or web account JWT). */
export interface SurveyOptions {
  getToken?: SurveyTokenGetter;
}

/** Returns whether the current user has already completed the survey. On error or unauthenticated, returns completed: true so we don't show the modal. */
export async function getSurveyStatus(options?: SurveyOptions): Promise<{ completed: boolean }> {
  try {
    const token = await resolveToken(options?.getToken);
    const res = await fetch(`${surveyApiBase()}/api/survey/status`, {
      method: "GET",
      headers: headersWithToken(token),
    });
    if (!res.ok) return { completed: true };
    const data = (await res.json()) as { completed?: boolean };
    return { completed: !!data.completed };
  } catch {
    return { completed: true };
  }
}

export async function submitSurvey(answers: SurveyAnswers, options?: SurveyOptions): Promise<void> {
  const token = await resolveToken(options?.getToken);
  const res = await fetch(`${surveyApiBase()}/api/survey`, {
    method: "POST",
    headers: headersWithToken(token),
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? "Failed to submit survey");
  }
}
