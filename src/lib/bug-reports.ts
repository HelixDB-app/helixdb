import { APP_CHANNEL, APP_VERSION } from "@/lib/app-config";
import {
  isNoInternetError,
  notifyNoInternetDetected,
} from "@/lib/network-errors";

const CONFIGURED_WEB_BASE_URL =
  process.env.NEXT_PUBLIC_WEB_APP_URL?.trim() ?? "";
const REPORTER_SESSION_STORAGE_KEY = "helix_bug_reporter_session_id";

const ACCEPTED_SCREENSHOT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getApiBaseUrl(): string {
  if (CONFIGURED_WEB_BASE_URL) {
    return trimTrailingSlash(CONFIGURED_WEB_BASE_URL);
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return trimTrailingSlash(window.location.origin);
  }
  return "";
}

function makeApiUrl(pathname: string): string {
  const base = getApiBaseUrl();
  if (!base) return pathname;
  return `${base}${pathname}`;
}

export const BUG_REPORT_TYPES = ["bug", "feature", "idea"] as const;
export type BugReportType = (typeof BUG_REPORT_TYPES)[number];

export const BUG_REPORT_STATUSES = [
  "backlog",
  "todo",
  "today",
  "in_staging",
  "done",
  "released",
] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

export const BUG_REPORT_LIMITS = {
  minTitleLength: 5,
  maxTitleLength: 120,
  minDescriptionLength: 20,
  maxDescriptionLength: 4000,
  minReporterNameLength: 2,
  maxReporterNameLength: 120,
  maxScreenshots: 3,
  maxScreenshotSizeBytes: 10 * 1024 * 1024,
} as const;

type UploadPhase = "creating" | "optimizing" | "uploading" | "finalizing";

export interface BugReportFormInput {
  reportType: BugReportType;
  reporterName: string;
  reporterEmail: string;
  title: string;
  description: string;
  screenshots: File[];
}

export interface BugReportContext {
  reporterSessionId: string;
  connection: {
    isConnected: boolean;
    databaseName: string | null;
    serverVersion: string | null;
  };
}

export interface BugReportFieldErrors {
  reportType?: string;
  reporterName?: string;
  reporterEmail?: string;
  title?: string;
  description?: string;
  screenshots?: string;
}

export interface BugReportUploadProgress {
  phase: UploadPhase;
  current: number;
  total: number;
}

export interface BugReportFeedItem {
  id: string;
  reportType: BugReportType;
  title: string;
  description: string;
  status: BugReportStatus;
  screenshotCount: number;
  createdAtMs: number;
  lastUpdateMessage?: string;
  lastCommitSummary?: string;
}

interface ApiBugReport {
  id: string;
  reportType: BugReportType;
  title: string;
  description: string;
  status: BugReportStatus;
  screenshotCount: number;
  createdAt: string;
  lastUpdateMessage?: string;
  lastCommitSummary?: string;
}

export class BugReportValidationError extends Error {
  public readonly fieldErrors: BugReportFieldErrors;

  constructor(fieldErrors: BugReportFieldErrors) {
    super("Bug report form validation failed.");
    this.name = "BugReportValidationError";
    this.fieldErrors = fieldErrors;
  }
}

function createLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function trimAndCollapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasErrors(errors: BugReportFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function mapError(error: unknown): string {
  if (error instanceof BugReportValidationError) {
    return "Please fix the highlighted fields and try again.";
  }

  if (error instanceof Error) {
    if (isNoInternetError(error)) {
      notifyNoInternetDetected(error);
      return "No internet connection. Please reconnect and retry.";
    }
    return error.message;
  }

  if (isNoInternetError(error)) {
    notifyNoInternetDetected(error);
    return "No internet connection. Please reconnect and retry.";
  }

  return "Unable to submit bug report. Please try again.";
}

function isStoragePathError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("erofs") ||
    message.includes("read-only file system") ||
    message.includes("mkdir")
  );
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function getAuthHeaders(): HeadersInit {
  const headers: HeadersInit = {};
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("pgstudio_jwt");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  return headers;
}

function getReporterSessionIdForFeed(): string {
  if (typeof window === "undefined") return "desktop-unknown";
  const existing = localStorage.getItem(REPORTER_SESSION_STORAGE_KEY);
  if (existing) return existing;
  const generated = createLocalId();
  localStorage.setItem(REPORTER_SESSION_STORAGE_KEY, generated);
  return generated;
}

function validateReportType(reportType: BugReportType): string | undefined {
  if (!BUG_REPORT_TYPES.includes(reportType)) {
    return "Please choose a valid report type.";
  }
  return undefined;
}

function validateReporterName(name: string): string | undefined {
  const normalized = trimAndCollapse(name);
  if (normalized.length < BUG_REPORT_LIMITS.minReporterNameLength) {
    return `Name must be at least ${BUG_REPORT_LIMITS.minReporterNameLength} characters.`;
  }
  if (normalized.length > BUG_REPORT_LIMITS.maxReporterNameLength) {
    return `Name must be ${BUG_REPORT_LIMITS.maxReporterNameLength} characters or fewer.`;
  }
  return undefined;
}

function validateReporterEmail(email: string): string | undefined {
  if (!isValidEmail(email)) {
    return "Please enter a valid email address.";
  }
  return undefined;
}

function validateTitle(title: string): string | undefined {
  const normalized = trimAndCollapse(title);
  if (normalized.length < BUG_REPORT_LIMITS.minTitleLength) {
    return `Title must be at least ${BUG_REPORT_LIMITS.minTitleLength} characters.`;
  }
  if (normalized.length > BUG_REPORT_LIMITS.maxTitleLength) {
    return `Title must be ${BUG_REPORT_LIMITS.maxTitleLength} characters or fewer.`;
  }
  return undefined;
}

function validateDescription(description: string): string | undefined {
  const normalized = description.trim();
  if (normalized.length < BUG_REPORT_LIMITS.minDescriptionLength) {
    return `Description must be at least ${BUG_REPORT_LIMITS.minDescriptionLength} characters.`;
  }
  if (normalized.length > BUG_REPORT_LIMITS.maxDescriptionLength) {
    return `Description must be ${BUG_REPORT_LIMITS.maxDescriptionLength} characters or fewer.`;
  }
  return undefined;
}

export function validateScreenshotFiles(files: File[]): string | undefined {
  if (files.length > BUG_REPORT_LIMITS.maxScreenshots) {
    return `You can attach up to ${BUG_REPORT_LIMITS.maxScreenshots} screenshots.`;
  }

  for (const file of files) {
    if (!ACCEPTED_SCREENSHOT_TYPES.has(file.type)) {
      return `Unsupported screenshot type \"${file.type || "unknown"}\".`;
    }
    if (file.size > BUG_REPORT_LIMITS.maxScreenshotSizeBytes) {
      return `Screenshot \"${file.name}\" is too large (${formatBytes(
        file.size
      )}). Max size is ${formatBytes(BUG_REPORT_LIMITS.maxScreenshotSizeBytes)}.`;
    }
  }

  return undefined;
}

export function validateBugReportInput(
  input: BugReportFormInput
): BugReportFieldErrors {
  return {
    reportType: validateReportType(input.reportType),
    reporterName: validateReporterName(input.reporterName),
    reporterEmail: validateReporterEmail(input.reporterEmail),
    title: validateTitle(input.title),
    description: validateDescription(input.description),
    screenshots: validateScreenshotFiles(input.screenshots),
  };
}

export function getBugReportingAvailability(): {
  canSubmit: boolean;
  canUploadScreenshots: boolean;
  reason?: string;
} {
  if (!getApiBaseUrl() && typeof window === "undefined") {
    return {
      canSubmit: false,
      canUploadScreenshots: false,
      reason:
        "Bug reporting is unavailable during server rendering. Try again from the client session.",
    };
  }

  return { canSubmit: true, canUploadScreenshots: true };
}

function mapApiReport(report: ApiBugReport): BugReportFeedItem {
  const safeStatus = BUG_REPORT_STATUSES.includes(report.status)
    ? report.status
    : "backlog";

  return {
    id: report.id,
    reportType: BUG_REPORT_TYPES.includes(report.reportType)
      ? report.reportType
      : "bug",
    title: report.title,
    description: report.description,
    status: safeStatus,
    screenshotCount:
      typeof report.screenshotCount === "number" ? report.screenshotCount : 0,
    createdAtMs: Number.isFinite(new Date(report.createdAt).getTime())
      ? new Date(report.createdAt).getTime()
      : Date.now(),
    lastUpdateMessage: report.lastUpdateMessage,
    lastCommitSummary: report.lastCommitSummary,
  };
}

function buildBugReportFormData(
  normalized: BugReportFormInput,
  context: BugReportContext,
  screenshots: File[]
): FormData {
  const formData = new FormData();
  formData.append("reportType", normalized.reportType);
  formData.append("reporterName", normalized.reporterName);
  formData.append("reporterEmail", normalized.reporterEmail);
  formData.append("title", normalized.title);
  formData.append("description", normalized.description);
  formData.append("reporterSessionId", context.reporterSessionId);
  formData.append("sourceApp", "desktop");
  formData.append("appVersion", APP_VERSION);
  formData.append("appChannel", APP_CHANNEL);
  formData.append("connection", JSON.stringify(context.connection));

  if (typeof window !== "undefined") {
    formData.append("platform", navigator.platform || "unknown");
    formData.append("userAgent", navigator.userAgent || "unknown");
    formData.append("language", navigator.language || "unknown");
    formData.append(
      "timezone",
      Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"
    );
    formData.append(
      "viewport",
      JSON.stringify({ width: window.innerWidth, height: window.innerHeight })
    );
  }

  for (const screenshot of screenshots) {
    formData.append("screenshots", screenshot);
  }

  return formData;
}

async function postBugReport(formData: FormData): Promise<{ reportId: string }> {
  const response = await fetch(makeApiUrl("/api/bug-reports"), {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  const payload = await parseJsonResponse<{
    report?: { id: string };
    error?: string;
    warning?: string;
  }>(response);

  if (!response.ok || !payload?.report?.id) {
    const reason =
      payload?.error ||
      `Failed to submit report (HTTP ${response.status}).`;
    throw new Error(reason);
  }

  return { reportId: payload.report.id };
}

export async function submitBugReport(
  input: BugReportFormInput,
  context: BugReportContext,
  onProgress?: (progress: BugReportUploadProgress) => void
): Promise<{ reportId: string }> {
  const normalized: BugReportFormInput = {
    reportType: input.reportType,
    reporterName: trimAndCollapse(input.reporterName),
    reporterEmail: input.reporterEmail.trim().toLowerCase(),
    title: trimAndCollapse(input.title),
    description: input.description.trim(),
    screenshots: input.screenshots,
  };

  const errors = validateBugReportInput(normalized);
  if (hasErrors(errors)) {
    throw new BugReportValidationError(errors);
  }

  const availability = getBugReportingAvailability();
  if (!availability.canSubmit) {
    throw new Error(availability.reason || "Bug reporting is unavailable.");
  }

  const totalScreenshots = normalized.screenshots.length;

  onProgress?.({ phase: "creating", current: 0, total: totalScreenshots });
  if (totalScreenshots > 0) {
    onProgress?.({ phase: "optimizing", current: 1, total: totalScreenshots });
    onProgress?.({ phase: "uploading", current: 1, total: totalScreenshots });
  }

  try {
    try {
      const withScreenshots = buildBugReportFormData(
        normalized,
        context,
        normalized.screenshots
      );
      const result = await postBugReport(withScreenshots);
      onProgress?.({
        phase: "finalizing",
        current: totalScreenshots,
        total: totalScreenshots,
      });
      return result;
    } catch (error) {
      const canRetryWithoutScreenshots =
        totalScreenshots > 0 && isStoragePathError(error);
      if (!canRetryWithoutScreenshots) {
        throw error;
      }

      const metadataOnly = buildBugReportFormData(normalized, context, []);
      const result = await postBugReport(metadataOnly);
      onProgress?.({
        phase: "finalizing",
        current: totalScreenshots,
        total: totalScreenshots,
      });
      return result;
    }
  } catch (error) {
    throw new Error(mapError(error));
  }
}

async function fetchRecentReports(maxItems: number): Promise<BugReportFeedItem[]> {
  const reporterSessionId = getReporterSessionIdForFeed();
  const params = new URLSearchParams({
    reporterSessionId,
    limit: String(Math.min(Math.max(maxItems, 1), 50)),
  });

  const response = await fetch(`${makeApiUrl("/api/bug-reports")}?${params}`, {
    headers: getAuthHeaders(),
  });

  const payload = (await parseJsonResponse<{
    reports?: ApiBugReport[];
    error?: string;
  }>(response)) ?? { reports: [] };

  if (!response.ok) {
    throw new Error(payload.error || `Unable to load reports (HTTP ${response.status}).`);
  }

  return (payload.reports ?? []).map(mapApiReport);
}

export function subscribeToRecentBugReports(
  onChange: (reports: BugReportFeedItem[]) => void,
  onError?: (message: string) => void,
  maxItems: number = 20
): () => void {
  const availability = getBugReportingAvailability();
  if (!availability.canSubmit) {
    onError?.(availability.reason || "Bug reporting is unavailable.");
    return () => {};
  }

  let cancelled = false;

  const run = async () => {
    try {
      const reports = await fetchRecentReports(maxItems);
      if (!cancelled) {
        onChange(reports);
      }
    } catch (error) {
      if (!cancelled) {
        onError?.(mapError(error));
      }
    }
  };

  void run();
  const interval = setInterval(() => {
    void run();
  }, 25_000);

  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}
