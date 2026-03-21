"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connection-store";
import { useAuthStore } from "@/stores/auth-store";
import { APP_NAME, APP_CHANNEL } from "@/lib/app-config";
import { appLogPath, openPath } from "@/lib/tauri";
import {
  BUG_REPORT_LIMITS,
  BUG_REPORT_TYPES,
  type BugReportFeedItem,
  type BugReportFieldErrors,
  type BugReportStatus,
  type BugReportType,
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
  Bug,
  CheckCircle2,
  Clock3,
  FileText,
  ImagePlus,
  Lightbulb,
  Loader2,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  Sparkles,
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
  return Boolean(
    errors.reportType ||
      errors.reporterName ||
      errors.reporterEmail ||
      errors.title ||
      errors.description ||
      errors.screenshots
  );
}

function getReporterSessionId(): string {
  if (typeof window === "undefined") return "desktop-unknown";
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
      return "Creating report record...";
    case "optimizing":
      return `Optimizing screenshot ${progress.current}/${progress.total}...`;
    case "uploading":
      return `Uploading screenshot ${progress.current}/${progress.total}...`;
    case "finalizing":
      return "Finalizing submission...";
  }
}

function statusPillClass(status: BugReportStatus): string {
  switch (status) {
    case "backlog":
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
    case "todo":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30";
    case "today":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "in_staging":
      return "bg-violet-500/15 text-violet-300 border-violet-500/30";
    case "done":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "released":
      return "bg-teal-500/15 text-teal-300 border-teal-500/30";
  }
}

function statusLabel(status: BugReportStatus): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "todo":
      return "Todo";
    case "today":
      return "Today";
    case "in_staging":
      return "In Staging";
    case "done":
      return "Done";
    case "released":
      return "Released";
  }
}

function reportTypeLabel(reportType: BugReportType): string {
  switch (reportType) {
    case "bug":
      return "Bug";
    case "feature":
      return "Feature";
    case "idea":
      return "Idea";
  }
}

function reportTypeBadgeClass(reportType: BugReportType): string {
  switch (reportType) {
    case "bug":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "feature":
      return "bg-blue-500/15 text-blue-300 border-blue-500/30";
    case "idea":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  }
}

function reportTypeIcon(reportType: BugReportType) {
  switch (reportType) {
    case "bug":
      return <Bug className="h-3.5 w-3.5" />;
    case "feature":
      return <Sparkles className="h-3.5 w-3.5" />;
    case "idea":
      return <Lightbulb className="h-3.5 w-3.5" />;
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

  const [reportType, setReportType] = useState<BugReportType>("bug");
  const [reporterName, setReporterName] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
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

  const [isTauri, setIsTauri] = useState(false);
  const [logPathCopied, setLogPathCopied] = useState(false);

  const authUser = useAuthStore((state) => state.user);
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
    if (authUser?.name && reporterName.length === 0) {
      setReporterName(authUser.name);
    }
    if (authUser?.email && reporterEmail.length === 0) {
      setReporterEmail(authUser.email);
    }
  }, [authUser?.email, authUser?.name, reporterEmail.length, reporterName.length]);

  useEffect(() => {
    setIsTauri(
      typeof window !== "undefined" &&
        !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
    );
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
    setReportType("bug");
    setTitle("");
    setDescription("");
    clearScreenshots();
    setErrors({});
    setSubmitError(null);
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
      reportType,
      reporterName,
      reporterEmail,
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
      toast.success("Report submitted successfully.");
      resetForm();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to submit feedback report.";
      setSubmitError(
        message
      );
      toast.error(message);
    } finally {
      setProgressLabel(null);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-transparent">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-4 border-b border-border/30 pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                MongoDB Bug Tracker + Screenshot Storage
              </p>
              {APP_CHANNEL === "beta" && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-400">
                  Beta
                </span>
              )}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">User Feedback & Bug Report</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Send bugs, feature requests, and ideas from {APP_NAME}. Reports are tracked end-to-end in the admin Kanban with status updates and notifications.
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
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="reporter-name">
                    Name
                  </label>
                  <Input
                    id="reporter-name"
                    value={reporterName}
                    onChange={(event) => {
                      setReporterName(event.target.value);
                      setErrors((previous) => ({ ...previous, reporterName: undefined }));
                    }}
                    placeholder="Your name"
                    maxLength={BUG_REPORT_LIMITS.maxReporterNameLength}
                    disabled={isSubmitting || !availability.canSubmit}
                    aria-invalid={Boolean(errors.reporterName)}
                  />
                  <span className="text-xs text-red-400">{errors.reporterName}</span>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="reporter-email">
                    Email
                  </label>
                  <Input
                    id="reporter-email"
                    type="email"
                    value={reporterEmail}
                    onChange={(event) => {
                      setReporterEmail(event.target.value);
                      setErrors((previous) => ({ ...previous, reporterEmail: undefined }));
                    }}
                    placeholder="you@example.com"
                    disabled={isSubmitting || !availability.canSubmit}
                    aria-invalid={Boolean(errors.reporterEmail)}
                  />
                  <span className="text-xs text-red-400">{errors.reporterEmail}</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="report-type">
                  Report Type
                </label>
                <select
                  id="report-type"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={reportType}
                  onChange={(event) => {
                    setReportType(event.target.value as BugReportType);
                    setErrors((previous) => ({ ...previous, reportType: undefined }));
                  }}
                  disabled={isSubmitting || !availability.canSubmit}
                >
                  {BUG_REPORT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {reportTypeLabel(type)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-red-400">{errors.reportType}</span>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="bug-title">
                  Title
                </label>
                <Input
                  id="bug-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setErrors((previous) => ({ ...previous, title: undefined }));
                  }}
                  placeholder="Short summary"
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
                    Up to {BUG_REPORT_LIMITS.maxScreenshots} screenshots. Supported: PNG,
                    JPEG, WebP. Max {Math.round(BUG_REPORT_LIMITS.maxScreenshotSizeBytes / (1024 * 1024))}MB each.
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
                          <p className="truncate text-xs font-medium">{shot.file.name}</p>
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
                  <AlertTitle>Feedback submitted</AlertTitle>
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
                      Submit report
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
                <h2 className="text-sm font-semibold">Recent report updates</h2>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Auto refresh
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
                <p className="text-sm text-muted-foreground">No reports submitted yet.</p>
              )}

              {!isFeedLoading && !feedError && recentReports.length > 0 && (
                <ul className="space-y-3">
                  {recentReports.map((report) => (
                    <li
                      key={report.id}
                      className="rounded-lg border border-border/30 bg-background/40 p-3"
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                            reportTypeBadgeClass(report.reportType)
                          )}
                        >
                          {reportTypeIcon(report.reportType)}
                          {reportTypeLabel(report.reportType)}
                        </span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px]",
                            statusPillClass(report.status)
                          )}
                        >
                          {statusLabel(report.status)}
                        </span>
                      </div>

                      <p className="line-clamp-2 text-sm font-medium">{report.title}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {report.description}
                      </p>

                      {(report.lastUpdateMessage || report.lastCommitSummary) && (
                        <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2 text-[11px] text-muted-foreground">
                          {report.lastUpdateMessage && (
                            <p className="text-foreground/90">{report.lastUpdateMessage}</p>
                          )}
                          {report.lastCommitSummary && (
                            <p className="mt-1">Commit: {report.lastCommitSummary}</p>
                          )}
                        </div>
                      )}

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

            {isTauri && (
              <section className="rounded-2xl border border-border/40 bg-card/40 p-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <FileText className="h-4 w-4" />
                  Debug log (TestFlight / desktop)
                </h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  Errors are written to a log file. Use these logs to add technical context when reporting issues.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={async () => {
                      try {
                        const path = await appLogPath();
                        await navigator.clipboard.writeText(path);
                        setLogPathCopied(true);
                        setTimeout(() => setLogPathCopied(false), 2000);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    {logPathCopied ? "Copied" : "Copy log path"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={async () => {
                      try {
                        const path = await appLogPath();
                        await openPath(path);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    Open log folder
                  </Button>
                </div>
              </section>
            )}

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
