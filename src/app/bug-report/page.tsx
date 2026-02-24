"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { APP_NAME } from "@/lib/app-config";
import {
  BUG_REPORT_LIMITS,
  type BugReportFeedItem,
  type BugReportFieldErrors,
  type BugReportUploadProgress,
  getBugReportingAvailability,
  submitBugReport,
  subscribeToRecentBugReports,
  validateBugReportInput,
  validateScreenshotFiles,
} from "@/lib/bug-reports";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ImagePlus,
  Loader2,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

const REPORTER_SESSION_STORAGE_KEY = "helix_bug_reporter_session_id";

type SelectedScreenshot = {
  id: string;
  file: File;
  previewUrl: string;
};

function createLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasFieldErrors(errors: BugReportFieldErrors): boolean {
  return Boolean(errors.title || errors.description || errors.screenshots);
}

function getReporterSessionId(): string {
  if (typeof window === "undefined") return "unknown";
  const existing = localStorage.getItem(REPORTER_SESSION_STORAGE_KEY);
  if (existing) return existing;
  const sessionId = createLocalId();
  localStorage.setItem(REPORTER_SESSION_STORAGE_KEY, sessionId);
  return sessionId;
}

function formatDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestampMs);
}

function toProgressLabel(progress: BugReportUploadProgress): string {
  switch (progress.phase) {
    case "creating":
      return "Creating bug report record...";
    case "optimizing":
      return `Optimizing screenshot ${progress.current}/${progress.total}...`;
    case "uploading":
      return `Uploading screenshot ${progress.current}/${progress.total}...`;
    case "finalizing":
      return "Finalizing submission...";
  }
}

function statusPillClass(status: BugReportFeedItem["status"]): string {
  switch (status) {
    case "submitted":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "uploading":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "upload_failed":
      return "bg-red-500/15 text-red-300 border-red-500/30";
  }
}

function statusLabel(status: BugReportFeedItem["status"]): string {
  switch (status) {
    case "submitted":
      return "Submitted";
    case "uploading":
      return "Uploading";
    case "upload_failed":
      return "Upload failed";
  }
}

export default function BugReportPage() {
  const [availability, setAvailability] = useState<ReturnType<
    typeof getBugReportingAvailability
  >>({
    canSubmit: false,
    canUploadScreenshots: false,
    reason: undefined,
  });
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const screenshotsRef = useRef<SelectedScreenshot[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [screenshots, setScreenshots] = useState<SelectedScreenshot[]>([]);
  const [errors, setErrors] = useState<BugReportFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  const [recentReports, setRecentReports] = useState<BugReportFeedItem[]>([]);
  const [isFeedLoading, setIsFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  const isConnected = useConnectionStore((state) => state.isConnected);
  const databaseName = useConnectionStore((state) => state.databaseName);
  const serverVersion = useConnectionStore((state) => state.serverVersion);

  const screenshotFiles = useMemo(
    () => screenshots.map((item) => item.file),
    [screenshots]
  );

  useEffect(() => {
    setAvailability(getBugReportingAvailability());
    setAvailabilityReady(true);
  }, []);

  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  useEffect(() => {
    return () => {
      screenshotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.previewUrl));
    };
  }, []);

  useEffect(() => {
    if (!availabilityReady) return;
    if (!availability.canSubmit) {
      setIsFeedLoading(false);
      return;
    }

    setIsFeedLoading(true);
    setFeedError(null);

    let mounted = true;
    const unsubscribe = subscribeToRecentBugReports(
      (reports) => {
        if (mounted) {
          setRecentReports(reports);
          setFeedError(null);
          setIsFeedLoading(false);
        }
      },
      (message) => {
        if (mounted) {
          setFeedError(message);
          setIsFeedLoading(false);
        }
      },
      12
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [availabilityReady, availability.canSubmit]);

  const clearScreenshots = () => {
    screenshots.forEach((shot) => URL.revokeObjectURL(shot.previewUrl));
    setScreenshots([]);
    setErrors((previous) => ({ ...previous, screenshots: undefined }));
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    clearScreenshots();
    setErrors({});
  };

  const handleFilesAdded = (fileList: FileList | null) => {
    if (!fileList) return;

    const selected = Array.from(fileList);
    if (selected.length === 0) return;

    setSubmittedReportId(null);
    setSubmitError(null);

    const slotsLeft = BUG_REPORT_LIMITS.maxScreenshots - screenshots.length;
    const filesToConsider = selected.slice(0, Math.max(0, slotsLeft));

    const nextScreenshots: SelectedScreenshot[] = [];
    let localError: string | undefined;

    for (const file of filesToConsider) {
      const validationError = validateScreenshotFiles([file]);
      if (validationError) {
        localError = validationError;
        continue;
      }
      nextScreenshots.push({
        id: createLocalId(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }

    const merged = [...screenshots, ...nextScreenshots];
    const mergedValidationError = validateScreenshotFiles(
      merged.map((item) => item.file)
    );

    if (mergedValidationError) {
      nextScreenshots.forEach((shot) => URL.revokeObjectURL(shot.previewUrl));
      setErrors((previous) => ({
        ...previous,
        screenshots: mergedValidationError,
      }));
      return;
    }

    if (selected.length > slotsLeft) {
      localError = `Only ${BUG_REPORT_LIMITS.maxScreenshots} screenshots are allowed. Extra files were ignored.`;
    }

    setScreenshots(merged);
    setErrors((previous) => ({
      ...previous,
      screenshots: localError,
    }));
  };

  const removeScreenshot = (id: string) => {
    const target = screenshots.find((item) => item.id === id);
    if (target) {
      URL.revokeObjectURL(target.previewUrl);
    }
    const next = screenshots.filter((item) => item.id !== id);
    setScreenshots(next);
    setErrors((previous) => ({
      ...previous,
      screenshots: validateScreenshotFiles(next.map((item) => item.file)),
    }));
  };

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmittedReportId(null);

    const formInput = {
      title,
      description,
      screenshots: screenshotFiles,
    };

    const validationErrors = validateBugReportInput(formInput);
    if (hasFieldErrors(validationErrors)) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});

    setIsSubmitting(true);
    setProgressLabel("Preparing submission...");

    try {
      const result = await submitBugReport(
        formInput,
        {
          reporterSessionId: getReporterSessionId(),
          connection: {
            isConnected,
            databaseName: databaseName || null,
            serverVersion: serverVersion || null,
          },
        },
        (progress) => setProgressLabel(toProgressLabel(progress))
      );
      setSubmittedReportId(result.reportId);
      resetForm();
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to submit the bug report."
      );
    } finally {
      setProgressLabel(null);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-4 border-b border-border/30 pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              Realtime Database + Encrypted Storage
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">User Feedback & Bug Report</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Share precise issues from {APP_NAME} with screenshots. Reports are saved to Firebase Realtime Database for live, low-latency triage and resolution.
            </p>
          </div>
          <Button asChild variant="outline" className="w-fit">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Back to Workspace
            </Link>
          </Button>
        </header>

        {availabilityReady && !availability.canSubmit && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Bug reporting is not configured</AlertTitle>
            <AlertDescription>{availability.reason}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
          <section className="rounded-2xl border border-border/40 bg-card/40 p-6">
            <form className="space-y-6" onSubmit={handleSubmit} noValidate>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="bug-title">
                  Bug title
                </label>
                <Input
                  id="bug-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setErrors((previous) => ({ ...previous, title: undefined }));
                  }}
                  placeholder="Short summary of the issue"
                  maxLength={BUG_REPORT_LIMITS.maxTitleLength}
                  disabled={isSubmitting || !availability.canSubmit}
                  aria-invalid={Boolean(errors.title)}
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-red-400">{errors.title}</span>
                  <span className="text-muted-foreground/70">
                    {title.trim().length}/{BUG_REPORT_LIMITS.maxTitleLength}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="bug-description">
                  Detailed description
                </label>
                <Textarea
                  id="bug-description"
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setErrors((previous) => ({
                      ...previous,
                      description: undefined,
                    }));
                  }}
                  placeholder="What happened, what did you expect, and steps to reproduce."
                  className="min-h-40 resize-y"
                  maxLength={BUG_REPORT_LIMITS.maxDescriptionLength}
                  disabled={isSubmitting || !availability.canSubmit}
                  aria-invalid={Boolean(errors.description)}
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-red-400">{errors.description}</span>
                  <span className="text-muted-foreground/70">
                    {description.trim().length}/{BUG_REPORT_LIMITS.maxDescriptionLength}
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-sm font-medium" htmlFor="bug-screenshots">
                    Screenshots
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      isSubmitting ||
                      !availability.canSubmit ||
                      !availability.canUploadScreenshots
                    }
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus className="h-4 w-4" />
                    Attach screenshots
                  </Button>
                </div>

                <input
                  ref={fileInputRef}
                  id="bug-screenshots"
                  type="file"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(event) => {
                    handleFilesAdded(event.target.files);
                    event.target.value = "";
                  }}
                  disabled={
                    isSubmitting ||
                    !availability.canSubmit ||
                    !availability.canUploadScreenshots
                  }
                />

                <div
                  className={cn(
                    "rounded-xl border border-dashed p-3 text-xs",
                    errors.screenshots
                      ? "border-red-500/50 bg-red-500/5"
                      : "border-border/40 bg-background/40"
                  )}
                >
                  <p className="text-muted-foreground">
                    Up to {BUG_REPORT_LIMITS.maxScreenshots} screenshots. Supported: PNG, JPEG, WebP. Max {Math.round(BUG_REPORT_LIMITS.maxScreenshotSizeBytes / (1024 * 1024))}MB each.
                  </p>
                  {!availability.canUploadScreenshots && availability.canSubmit && (
                    <p className="mt-1 text-amber-300">{availability.reason}</p>
                  )}
                  {errors.screenshots && (
                    <p className="mt-1 text-red-400">{errors.screenshots}</p>
                  )}
                </div>

                {screenshots.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {screenshots.map((shot) => (
                      <figure
                        key={shot.id}
                        className="group relative overflow-hidden rounded-lg border border-border/40 bg-muted/20"
                      >
                        <Image
                          src={shot.previewUrl}
                          alt={shot.file.name}
                          width={640}
                          height={240}
                          unoptimized
                          className="h-32 w-full object-cover"
                        />
                        <figcaption className="space-y-1 p-2">
                          <p className="truncate text-xs font-medium">
                            {shot.file.name}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {(shot.file.size / 1024).toFixed(1)} KB
                          </p>
                        </figcaption>
                        <button
                          type="button"
                          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => removeScreenshot(shot.id)}
                          aria-label={`Remove ${shot.file.name}`}
                          disabled={isSubmitting}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </figure>
                    ))}
                  </div>
                )}
              </div>

              {progressLabel && (
                <div className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {progressLabel}
                </div>
              )}

              {submitError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Submission failed</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              {submittedReportId && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <AlertTitle>Bug report submitted</AlertTitle>
                  <AlertDescription>
                    Report ID: <span className="font-mono">{submittedReportId}</span>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  type="submit"
                  disabled={isSubmitting || !availability.canSubmit}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Paperclip className="h-4 w-4" />
                      Submit bug report
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={resetForm}
                >
                  Clear form
                </Button>
              </div>
            </form>
          </section>

          <aside className="space-y-6">
            <section className="rounded-2xl border border-border/40 bg-card/40 p-5">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Real-time report feed</h2>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Live
                </span>
              </div>

              {isFeedLoading && (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>Loading recent reports...</p>
                </div>
              )}

              {!isFeedLoading && feedError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Feed unavailable</AlertTitle>
                  <AlertDescription>{feedError}</AlertDescription>
                </Alert>
              )}

              {!isFeedLoading && !feedError && recentReports.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No reports submitted yet.
                </p>
              )}

              {!isFeedLoading && !feedError && recentReports.length > 0 && (
                <ul className="space-y-3">
                  {recentReports.map((report) => (
                    <li
                      key={report.id}
                      className="rounded-lg border border-border/30 bg-background/40 p-3"
                    >
                      <div className="mb-1.5 flex items-start justify-between gap-2">
                        <p className="line-clamp-2 text-sm font-medium">{report.title}</p>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px]",
                            statusPillClass(report.status)
                          )}
                        >
                          {statusLabel(report.status)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {report.description}
                      </p>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="h-3 w-3" />
                          {formatDateTime(report.createdAtMs)}
                        </span>
                        <span>{report.screenshotCount} screenshot(s)</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-border/40 bg-card/40 p-5">
              <h2 className="mb-3 text-sm font-semibold">Report quality checklist</h2>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>1. Include exact steps to reproduce the issue.</li>
                <li>2. Attach screenshots that capture errors or incorrect UI state.</li>
                <li>3. Mention expected behavior versus actual behavior.</li>
                <li>4. Include query/table context when database behavior is affected.</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
