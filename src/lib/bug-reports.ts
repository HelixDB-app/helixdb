import { APP_NAME, APP_VERSION } from "@/lib/app-config";
import { getFirebaseConfig } from "@/lib/firebase";
import {
  isNoInternetError,
  notifyNoInternetDetected,
} from "@/lib/network-errors";

const BUG_REPORTS_PATH = "bugReports";
const BUG_SCREENSHOT_FOLDER = "bug-report-screenshots";

const DATABASE_WRITE_TIMEOUT_MS = 20_000;
const SCREENSHOT_OPTIMIZE_TIMEOUT_MS = 25_000;
const SCREENSHOT_UPLOAD_TIMEOUT_MS = 90_000;
const FEED_INITIAL_TIMEOUT_MS = 15_000;

export const BUG_REPORT_LIMITS = {
  minTitleLength: 5,
  maxTitleLength: 120,
  minDescriptionLength: 20,
  maxDescriptionLength: 4000,
  maxScreenshots: 3,
  maxScreenshotSizeBytes: 10 * 1024 * 1024,
  maxScreenshotDimension: 1920,
  optimizedImageQuality: 0.84,
} as const;

const ACCEPTED_SCREENSHOT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

type BugReportStatus = "uploading" | "submitted" | "upload_failed";

type UploadPhase = "creating" | "optimizing" | "uploading" | "finalizing";

interface FirebaseRuntime {
  database: import("firebase/database").Database;
  storage: import("firebase/storage").FirebaseStorage;
  databaseModule: typeof import("firebase/database");
  storageModule: typeof import("firebase/storage");
}

export interface BugReportFormInput {
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
  title?: string;
  description?: string;
  screenshots?: string;
}

export interface BugReportUploadProgress {
  phase: UploadPhase;
  current: number;
  total: number;
}

export interface UploadedBugScreenshot {
  path: string;
  url: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  optimized: boolean;
}

export interface BugReportFeedItem {
  id: string;
  title: string;
  description: string;
  status: BugReportStatus;
  screenshotCount: number;
  createdAtMs: number;
  appVersion: string;
}

export class BugReportValidationError extends Error {
  public readonly fieldErrors: BugReportFieldErrors;

  constructor(fieldErrors: BugReportFieldErrors) {
    super("Bug report form validation failed.");
    this.name = "BugReportValidationError";
    this.fieldErrors = fieldErrors;
  }
}

let runtimePromise: Promise<FirebaseRuntime> | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasErrors(errors: BugReportFieldErrors): boolean {
  return Boolean(errors.title || errors.description || errors.screenshots);
}

function createStableId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function trimAndCollapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toSafeFileStem(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "screenshot";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
}

function collectClientEnvironment() {
  if (typeof window === "undefined") {
    return {
      userAgent: "unknown",
      platform: "unknown",
      language: "unknown",
      timezone: "unknown",
      viewport: { width: 0, height: 0 },
    };
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || "unknown",
    language: navigator.language || "unknown",
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}

function mapFirebaseError(error: unknown): string {
  if (error instanceof BugReportValidationError) {
    return "Please fix the highlighted fields and submit again.";
  }

  const code =
    isObject(error) && typeof error["code"] === "string"
      ? error["code"]
      : "";

  if (code.includes("permission-denied")) {
    return "Permission denied by Firebase rules. Verify Realtime Database and Storage access rules.";
  }
  if (code.includes("unauthenticated")) {
    return "Authentication is required to submit bug reports for this Firebase project.";
  }
  if (code.includes("storage/unauthorized")) {
    return "Screenshot upload is not authorized. Check Firebase Storage rules.";
  }
  if (code.includes("storage/retry-limit-exceeded")) {
    return "Screenshot upload timed out. Check your connection and try again.";
  }
  if (code.includes("network-request-failed")) {
    notifyNoInternetDetected(error);
    return "No internet connection. Reconnect and retry.";
  }
  if (code.includes("unavailable")) {
    return "Firebase is temporarily unavailable. Please retry in a moment.";
  }
  if (code.includes("invalid-argument")) {
    return "Invalid bug report payload. Review title, description, and screenshot formats.";
  }
  if (code.includes("unsupported-browser") || code.includes("messaging/")) {
    return "This browser or environment is not fully supported for bug reporting.";
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timed out")) {
      return "Submission timed out. Please retry.";
    }
    if (isNoInternetError(error)) {
      notifyNoInternetDetected(error);
      return "No internet connection. Reconnect and retry.";
    }
    if (error.message) return error.message;
  }

  if (isNoInternetError(error)) {
    notifyNoInternetDetected(error);
    return "No internet connection. Reconnect and retry.";
  }

  return "Unable to submit bug report. Please try again.";
}

function fileValidationError(file: File): string | null {
  if (!ACCEPTED_SCREENSHOT_TYPES.has(file.type)) {
    return `Unsupported screenshot type "${file.type || "unknown"}". Use PNG, JPEG, or WebP.`;
  }
  if (file.size > BUG_REPORT_LIMITS.maxScreenshotSizeBytes) {
    return `Screenshot "${file.name}" is too large (${formatBytes(
      file.size
    )}). Max size is ${formatBytes(BUG_REPORT_LIMITS.maxScreenshotSizeBytes)}.`;
  }
  return null;
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
    const error = fileValidationError(file);
    if (error) return error;
  }
  return undefined;
}

export function validateBugReportInput(
  input: BugReportFormInput
): BugReportFieldErrors {
  return {
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
  const config = getFirebaseConfig();
  if (!config) {
    return {
      canSubmit: false,
      canUploadScreenshots: false,
      reason:
        "Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID.",
    };
  }
  if (!config.databaseURL) {
    return {
      canSubmit: false,
      canUploadScreenshots: false,
      reason:
        "Realtime Database URL is missing. Add NEXT_PUBLIC_FIREBASE_DATABASE_URL.",
    };
  }
  if (!config.storageBucket) {
    return {
      canSubmit: true,
      canUploadScreenshots: false,
      reason:
        "Firebase Storage bucket is missing. Add NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET to enable screenshot uploads.",
    };
  }
  return { canSubmit: true, canUploadScreenshots: true };
}

async function getFirebaseRuntime(): Promise<FirebaseRuntime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const config = getFirebaseConfig();
    if (!config) {
      throw new Error(
        "Firebase is not configured. Add required NEXT_PUBLIC_FIREBASE_* variables."
      );
    }
    if (!config.databaseURL) {
      throw new Error(
        "Realtime Database URL is missing. Add NEXT_PUBLIC_FIREBASE_DATABASE_URL."
      );
    }

    const [appModule, databaseModule, storageModule] = await Promise.all([
      import("firebase/app"),
      import("firebase/database"),
      import("firebase/storage"),
    ]);

    const app =
      appModule.getApps().length > 0
        ? appModule.getApp()
        : appModule.initializeApp(config);

    const database = databaseModule.getDatabase(app, config.databaseURL);
    const storage = storageModule.getStorage(app);

    return {
      database,
      storage,
      databaseModule,
      storageModule,
    };
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });

  return runtimePromise;
}

function getScaledDimensions(width: number, height: number): {
  width: number;
  height: number;
} {
  const maxDimension = BUG_REPORT_LIMITS.maxScreenshotDimension;
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }
  const ratio = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function loadImageForCanvas(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof window === "undefined") {
    throw new Error("Screenshot optimization requires a browser environment.");
  }

  if ("createImageBitmap" in window) {
    const bitmap = await withTimeout(
      createImageBitmap(file),
      SCREENSHOT_OPTIMIZE_TIMEOUT_MS,
      `Optimizing screenshot "${file.name}" timed out.`
    );
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = objectUrl;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(`Unable to load screenshot "${file.name}".`));
    }),
    SCREENSHOT_OPTIMIZE_TIMEOUT_MS,
    `Optimizing screenshot "${file.name}" timed out.`
  );

  return {
    source: image,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    release: () => URL.revokeObjectURL(objectUrl),
  };
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Unable to encode optimized screenshot."));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });
}

async function optimizeScreenshot(file: File): Promise<{
  blob: Blob;
  width: number;
  height: number;
}> {
  const loaded = await loadImageForCanvas(file);
  try {
    const target = getScaledDimensions(loaded.width, loaded.height);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error(
        "Unable to allocate canvas context for screenshot optimization."
      );
    }

    context.drawImage(loaded.source, 0, 0, target.width, target.height);

    const blob = await withTimeout(
      canvasToBlob(
        canvas,
        "image/webp",
        BUG_REPORT_LIMITS.optimizedImageQuality
      ),
      SCREENSHOT_OPTIMIZE_TIMEOUT_MS,
      `Optimizing screenshot "${file.name}" timed out.`
    );

    return {
      blob,
      width: target.width,
      height: target.height,
    };
  } finally {
    loaded.release();
  }
}

async function uploadScreenshot(
  runtime: FirebaseRuntime,
  reportId: string,
  file: File,
  index: number
): Promise<UploadedBugScreenshot> {
  const optimized = await optimizeScreenshot(file);
  const safeStem = toSafeFileStem(file.name);
  const storagePath = `${BUG_SCREENSHOT_FOLDER}/${reportId}/${Date.now()}-${index + 1}-${createStableId()}-${safeStem}.webp`;
  const ref = runtime.storageModule.ref(runtime.storage, storagePath);

  await withTimeout(
    runtime.storageModule.uploadBytes(ref, optimized.blob, {
      contentType: "image/webp",
      cacheControl: "public,max-age=31536000,immutable",
      customMetadata: {
        originalName: file.name,
        originalType: file.type || "unknown",
        optimized: "true",
        source: "bug_report",
      },
    }),
    SCREENSHOT_UPLOAD_TIMEOUT_MS,
    `Uploading screenshot "${file.name}" timed out.`
  );

  const url = await withTimeout(
    runtime.storageModule.getDownloadURL(ref),
    DATABASE_WRITE_TIMEOUT_MS,
    `Fetching uploaded screenshot URL for "${file.name}" timed out.`
  );

  return {
    path: storagePath,
    url,
    originalName: file.name,
    contentType: "image/webp",
    sizeBytes: optimized.blob.size,
    width: optimized.width,
    height: optimized.height,
    optimized: true,
  };
}

function mapStatus(value: unknown): BugReportStatus {
  if (value === "uploading") return "uploading";
  if (value === "upload_failed") return "upload_failed";
  return "submitted";
}

export async function submitBugReport(
  input: BugReportFormInput,
  context: BugReportContext,
  onProgress?: (progress: BugReportUploadProgress) => void
): Promise<{ reportId: string }> {
  const trimmedInput: BugReportFormInput = {
    title: trimAndCollapse(input.title),
    description: input.description.trim(),
    screenshots: input.screenshots,
  };

  const errors = validateBugReportInput(trimmedInput);
  if (hasErrors(errors)) {
    throw new BugReportValidationError(errors);
  }

  const availability = getBugReportingAvailability();
  if (!availability.canSubmit) {
    throw new Error(availability.reason || "Bug reporting is unavailable.");
  }
  if (trimmedInput.screenshots.length > 0 && !availability.canUploadScreenshots) {
    throw new Error(
      availability.reason ||
        "Screenshot uploads are unavailable because Firebase Storage is not configured."
    );
  }

  const runtime = await getFirebaseRuntime();
  const totalScreenshots = trimmedInput.screenshots.length;
  let reportRef: import("firebase/database").DatabaseReference | null = null;
  let reportId: string | null = null;

  try {
    onProgress?.({ phase: "creating", current: 0, total: totalScreenshots });

    const createdAtMs = Date.now();
    const environment = collectClientEnvironment();
    const reportsRootRef = runtime.databaseModule.ref(
      runtime.database,
      BUG_REPORTS_PATH
    );
    reportId =
      runtime.databaseModule.push(reportsRootRef).key ?? createStableId();
    reportRef = runtime.databaseModule.ref(
      runtime.database,
      `${BUG_REPORTS_PATH}/${reportId}`
    );

    await withTimeout(
      runtime.databaseModule.set(reportRef, {
        title: trimmedInput.title,
        description: trimmedInput.description,
        status: totalScreenshots > 0 ? "uploading" : "submitted",
        screenshots: [],
        screenshotCount: 0,
        reporterSessionId: context.reporterSessionId,
        appName: APP_NAME,
        appVersion: APP_VERSION,
        createdAtMs,
        createdAtServer: runtime.databaseModule.serverTimestamp(),
        updatedAtServer: runtime.databaseModule.serverTimestamp(),
        submittedAtMs: totalScreenshots === 0 ? createdAtMs : null,
        connection: {
          isConnected: context.connection.isConnected,
          databaseName: context.connection.databaseName,
          serverVersion: context.connection.serverVersion,
        },
        environment,
      }),
      DATABASE_WRITE_TIMEOUT_MS,
      "Creating bug report record timed out."
    );

    const uploadedScreenshots: UploadedBugScreenshot[] = [];
    for (let index = 0; index < totalScreenshots; index += 1) {
      onProgress?.({
        phase: "optimizing",
        current: index + 1,
        total: totalScreenshots,
      });
      onProgress?.({
        phase: "uploading",
        current: index + 1,
        total: totalScreenshots,
      });

      const uploaded = await uploadScreenshot(
        runtime,
        reportId,
        trimmedInput.screenshots[index],
        index
      );
      uploadedScreenshots.push(uploaded);
    }

    onProgress?.({
      phase: "finalizing",
      current: totalScreenshots,
      total: totalScreenshots,
    });

    await withTimeout(
      runtime.databaseModule.update(reportRef, {
        status: "submitted",
        screenshots: uploadedScreenshots,
        screenshotCount: uploadedScreenshots.length,
        submittedAtMs: Date.now(),
        updatedAtServer: runtime.databaseModule.serverTimestamp(),
        uploadError: null,
      }),
      DATABASE_WRITE_TIMEOUT_MS,
      "Finalizing bug report timed out."
    );

    return { reportId };
  } catch (error) {
    if (reportRef && reportId) {
      try {
        await withTimeout(
          runtime.databaseModule.update(reportRef, {
            status: "upload_failed",
            uploadError: mapFirebaseError(error),
            updatedAtServer: runtime.databaseModule.serverTimestamp(),
          }),
          DATABASE_WRITE_TIMEOUT_MS,
          "Updating failed report status timed out."
        );
      } catch {
        // Best effort status update.
      }
    }
    throw new Error(mapFirebaseError(error));
  }
}

function mapRtdbReportToFeedItem(id: string, raw: unknown): BugReportFeedItem {
  const data = isObject(raw) ? raw : {};
  return {
    id,
    title:
      typeof data["title"] === "string" && data["title"].trim().length > 0
        ? data["title"]
        : "Untitled report",
    description: typeof data["description"] === "string" ? data["description"] : "",
    status: mapStatus(data["status"]),
    screenshotCount: Math.max(0, toFiniteNumber(data["screenshotCount"], 0)),
    createdAtMs: toFiniteNumber(data["createdAtMs"], Date.now()),
    appVersion:
      typeof data["appVersion"] === "string" ? data["appVersion"] : APP_VERSION,
  };
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
  let unsubscribe = () => {};
  let firstSnapshotSeen = false;
  let firstSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

  void (async () => {
    try {
      const runtime = await getFirebaseRuntime();
      if (cancelled) return;

      const clampedLimit = Math.min(Math.max(maxItems, 1), 50);
      const reportsQuery = runtime.databaseModule.query(
        runtime.databaseModule.ref(runtime.database, BUG_REPORTS_PATH),
        runtime.databaseModule.orderByChild("createdAtMs"),
        runtime.databaseModule.limitToLast(clampedLimit)
      );

      firstSnapshotTimer = setTimeout(() => {
        if (!firstSnapshotSeen && !cancelled) {
          onError?.(
            "Realtime feed is taking too long to load. You can still submit reports."
          );
        }
      }, FEED_INITIAL_TIMEOUT_MS);

      unsubscribe = runtime.databaseModule.onValue(
        reportsQuery,
        (snapshot) => {
          firstSnapshotSeen = true;
          if (firstSnapshotTimer) {
            clearTimeout(firstSnapshotTimer);
            firstSnapshotTimer = null;
          }
          if (cancelled) return;

          const reports: BugReportFeedItem[] = [];
          snapshot.forEach((child) => {
            reports.push(mapRtdbReportToFeedItem(child.key ?? createStableId(), child.val()));
          });
          reports.sort((a, b) => b.createdAtMs - a.createdAtMs);
          onChange(reports);
        },
        (error) => {
          firstSnapshotSeen = true;
          if (firstSnapshotTimer) {
            clearTimeout(firstSnapshotTimer);
            firstSnapshotTimer = null;
          }
          if (!cancelled) onError?.(mapFirebaseError(error));
        }
      );
    } catch (error) {
      if (firstSnapshotTimer) {
        clearTimeout(firstSnapshotTimer);
        firstSnapshotTimer = null;
      }
      if (!cancelled) onError?.(mapFirebaseError(error));
    }
  })();

  return () => {
    cancelled = true;
    if (firstSnapshotTimer) clearTimeout(firstSnapshotTimer);
    unsubscribe();
  };
}
