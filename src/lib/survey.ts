const WEB_BASE_URL =
  process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";

export type SurveyTokenGetter = () => Promise<string | null>;

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

export interface SurveyAnswers {
  howDidYouHear?: string;
  primaryReason?: string;
  userType?: string;
  featureInterest?: string;
  mainDatabase?: string;
}

/** Options for survey API calls. Pass getToken when using desktop app (token is in Tauri keychain, not localStorage). */
export interface SurveyOptions {
  getToken?: SurveyTokenGetter;
}

/** Returns whether the current user has already completed the survey. On error or unauthenticated, returns completed: true so we don't show the modal. */
export async function getSurveyStatus(options?: SurveyOptions): Promise<{ completed: boolean }> {
  try {
    const token = await resolveToken(options?.getToken);
    const res = await fetch(`${WEB_BASE_URL}/api/survey/status`, {
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
  const res = await fetch(`${WEB_BASE_URL}/api/survey`, {
    method: "POST",
    headers: headersWithToken(token),
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? "Failed to submit survey");
  }
}
