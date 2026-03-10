/**
 * Bug reports API handler logic (Node.js).
 * Used with static export: this file is NOT part of the Next.js build.
 * Use with a custom Node server (e.g. next dev or standalone) or adapt for Tauri invoke.
 *
 * Next.js app with output: "export" cannot use API routes; the route was removed
 * so the static export builds. Restore src/app/api/bug-reports/route.ts and
 * import from here when running with a server (e.g. pnpm dev or deployed web app).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const BUG_REPORT_TYPES = new Set(["bug", "feature", "idea"]);
const BUG_REPORT_STATUSES = new Set([
  "backlog",
  "todo",
  "today",
  "in_staging",
  "done",
  "released",
]);
const ACCEPTED_SCREENSHOT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_REPORTS_STORED = 2000;

type BugReportType = "bug" | "feature" | "idea";
type BugReportStatus =
  | "backlog"
  | "todo"
  | "today"
  | "in_staging"
  | "done"
  | "released";

export interface StoredBugReport {
  id: string;
  reportType: BugReportType;
  reporterName: string;
  reporterEmail: string;
  reporterSessionId: string;
  title: string;
  description: string;
  status: BugReportStatus;
  screenshotCount: number;
  screenshotFiles: string[];
  sourceApp: string;
  appVersion: string;
  appChannel: string;
  connection: string | null;
  platform: string | null;
  userAgent: string | null;
  language: string | null;
  timezone: string | null;
  viewport: string | null;
  lastUpdateMessage?: string;
  lastCommitSummary?: string;
  createdAt: string;
}

function isServerlessRuntime(): boolean {
  return (
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    process.cwd().startsWith("/var/task")
  );
}

function resolveStorageRoot(): string {
  const configured = process.env.BUG_REPORTS_STORAGE_DIR?.trim();
  if (configured) return configured;
  if (isServerlessRuntime()) {
    return path.join(os.tmpdir(), "pgstudio-bug-reports");
  }
  return path.join(process.cwd(), ".data", "bug-reports");
}

function indexFilePath(rootDir: string): string {
  return path.join(rootDir, "reports.json");
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readReports(filePath: string): Promise<StoredBugReport[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredBugReport[]) : [];
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeReports(
  filePath: string,
  reports: StoredBugReport[]
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(reports, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function toSafeString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function screenshotExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function shouldRetryWithoutScreenshots(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("erofs") ||
    normalized.includes("read-only file system") ||
    normalized.includes("operation not permitted") ||
    normalized.includes("mkdir")
  );
}

async function storeScreenshots(
  rootDir: string,
  reportId: string,
  screenshots: File[]
): Promise<string[]> {
  if (screenshots.length === 0) return [];

  const targetDir = path.join(rootDir, "screenshots", reportId);
  await ensureDir(targetDir);

  const saved: string[] = [];
  for (let i = 0; i < screenshots.length; i += 1) {
    const screenshot = screenshots[i];
    if (!ACCEPTED_SCREENSHOT_TYPES.has(screenshot.type)) {
      throw new Error(`Unsupported screenshot type: ${screenshot.type || "unknown"}`);
    }
    if (screenshot.size > MAX_SCREENSHOT_SIZE_BYTES) {
      throw new Error(`Screenshot exceeds ${MAX_SCREENSHOT_SIZE_BYTES} bytes.`);
    }

    const ext = screenshotExtension(screenshot.type);
    const filename = `screenshot-${String(i + 1).padStart(2, "0")}.${ext}`;
    const absolutePath = path.join(targetDir, filename);
    const bytes = Buffer.from(await screenshot.arrayBuffer());
    await fs.writeFile(absolutePath, bytes);
    saved.push(path.relative(rootDir, absolutePath));
  }

  return saved;
}

async function createReportFromFormData(
  formData: FormData
): Promise<{ report: StoredBugReport; storageWarning?: string }> {
  const reportType = toSafeString(formData.get("reportType"));
  const reporterName = toSafeString(formData.get("reporterName"));
  const reporterEmail = toSafeString(formData.get("reporterEmail")).toLowerCase();
  const title = toSafeString(formData.get("title"));
  const description = toSafeString(formData.get("description"));
  const reporterSessionId = toSafeString(formData.get("reporterSessionId"));
  const sourceApp = toSafeString(formData.get("sourceApp")) || "desktop";
  const appVersion = toSafeString(formData.get("appVersion")) || "unknown";
  const appChannel = toSafeString(formData.get("appChannel")) || "unknown";
  const connection = toSafeString(formData.get("connection")) || null;
  const platform = toSafeString(formData.get("platform")) || null;
  const userAgent = toSafeString(formData.get("userAgent")) || null;
  const language = toSafeString(formData.get("language")) || null;
  const timezone = toSafeString(formData.get("timezone")) || null;
  const viewport = toSafeString(formData.get("viewport")) || null;

  if (!BUG_REPORT_TYPES.has(reportType)) {
    throw new Error("Invalid report type.");
  }
  if (reporterName.length < 2) {
    throw new Error("Reporter name is required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
    throw new Error("Reporter email is invalid.");
  }
  if (title.length < 5) {
    throw new Error("Title must be at least 5 characters.");
  }
  if (description.length < 20) {
    throw new Error("Description must be at least 20 characters.");
  }
  if (!reporterSessionId) {
    throw new Error("Reporter session is required.");
  }

  const screenshotEntries = formData.getAll("screenshots");
  const screenshotFiles = screenshotEntries.filter(
    (entry): entry is File => typeof entry !== "string"
  );
  if (screenshotFiles.length > MAX_SCREENSHOTS) {
    throw new Error(`You can attach up to ${MAX_SCREENSHOTS} screenshots.`);
  }

  const rootDir = resolveStorageRoot();
  await ensureDir(rootDir);

  const id = randomUUID();
  let screenshotFilePaths: string[] = [];
  let storageWarning: string | undefined;

  try {
    screenshotFilePaths = await storeScreenshots(rootDir, id, screenshotFiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (screenshotFiles.length > 0 && shouldRetryWithoutScreenshots(message)) {
      storageWarning =
        "Screenshots could not be saved in this runtime. Report was stored without attachments.";
      screenshotFilePaths = [];
    } else {
      throw error;
    }
  }

  const report: StoredBugReport = {
    id,
    reportType: reportType as BugReportType,
    reporterName,
    reporterEmail,
    reporterSessionId,
    title,
    description,
    status: "backlog",
    screenshotCount: screenshotFilePaths.length,
    screenshotFiles: screenshotFilePaths,
    sourceApp,
    appVersion,
    appChannel,
    connection,
    platform,
    userAgent,
    language,
    timezone,
    viewport,
    createdAt: new Date().toISOString(),
  };

  const filePath = indexFilePath(rootDir);
  const existing = await readReports(filePath);
  const next = [report, ...existing].slice(0, MAX_REPORTS_STORED);
  await writeReports(filePath, next);

  return { report, storageWarning };
}

export async function handleBugReportsPost(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const { report, storageWarning } = await createReportFromFormData(formData);
    return jsonResponse(
      { report: { id: report.id }, warning: storageWarning },
      201
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to submit bug report.";
    return jsonResponse({ error: message }, 400);
  }
}

export async function handleBugReportsGet(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const reporterSessionId = searchParams.get("reporterSessionId")?.trim() ?? "";
    const rawLimit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 50))
      : 20;

    const rootDir = resolveStorageRoot();
    const reports = await readReports(indexFilePath(rootDir));
    const filtered =
      reporterSessionId.length > 0
        ? reports.filter((report) => report.reporterSessionId === reporterSessionId)
        : reports;

    const payload = filtered
      .sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      })
      .slice(0, limit)
      .map((report) => ({
        id: report.id,
        reportType: report.reportType,
        title: report.title,
        description: report.description,
        status: BUG_REPORT_STATUSES.has(report.status) ? report.status : "backlog",
        screenshotCount: report.screenshotCount,
        createdAt: report.createdAt,
        lastUpdateMessage: report.lastUpdateMessage,
        lastCommitSummary: report.lastCommitSummary,
      }));

    return jsonResponse({ reports: payload }, 200);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load bug reports.";
    return jsonResponse({ error: message }, 500);
  }
}
