"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { submitSurvey, type SurveyAnswers, type SurveyTokenGetter } from "@/lib/survey";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessageSquareQuote,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const QUESTIONS: Array<{ key: keyof SurveyAnswers; label: string; options: string[] }> = [
  {
    key: "howDidYouHear",
    label: "How did you hear about this application?",
    options: [
      "Google Search",
      "GitHub",
      "YouTube / Tutorials",
      "Social Media (Twitter, LinkedIn, etc.)",
      "Friend or Colleague",
      "Developer Community (Reddit, Discord, etc.)",
      "Other",
    ],
  },
  {
    key: "primaryReason",
    label: "What is your primary reason for using this app?",
    options: [
      "Database management",
      "SQL development",
      "Team collaboration",
      "Learning SQL",
      "Testing queries",
      "Other",
    ],
  },
  {
    key: "userType",
    label: "What type of user best describes you?",
    options: [
      "Backend Developer",
      "Full Stack Developer",
      "Data Engineer",
      "Database Administrator",
      "Student / Learner",
      "Other",
    ],
  },
  {
    key: "featureInterest",
    label: "What feature are you most interested in?",
    options: [
      "SQL Editor",
      "Query Performance Tools",
      "Team Collaboration",
      "Git Integration",
      "AI-powered features",
      "Database Visualization",
    ],
  },
  {
    key: "mainDatabase",
    label: "Which database do you mainly use?",
    options: ["PostgreSQL", "MySQL", "MongoDB", "SQLite", "Multiple Databases"],
  },
];

const TOTAL_STEPS = QUESTIONS.length;

interface SurveyModalProps {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  /** When provided (e.g. desktop app), use this to get the auth token for API calls. */
  getToken?: SurveyTokenGetter;
}

export function SurveyModal({ open, onClose, onSubmitted, getToken }: SurveyModalProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const question = QUESTIONS[step];
  const currentValue = question ? answers[question.key] : undefined;
  const isLastStep = step === TOTAL_STEPS - 1;
  const progress = ((step + 1) / TOTAL_STEPS) * 100;

  const handleSelect = useCallback(
    (value: string) => {
      if (!question) return;
      setAnswers((prev) => ({ ...prev, [question.key]: value }));
      setError(null);
    },
    [question]
  );

  const handleNext = useCallback(() => {
    if (!currentValue) return;

    if (isLastStep) {
      setSubmitting(true);
      setError(null);
      submitSurvey(answers, { getToken })
        .then(() => {
          setSuccess(true);
          setTimeout(() => {
            onSubmitted();
          }, 1800);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : "Failed to submit");
        })
        .finally(() => setSubmitting(false));
    } else {
      setStep((s) => s + 1);
    }
  }, [isLastStep, answers, onSubmitted, currentValue]);

  const handleSkip = useCallback(() => {
    setStep(0);
    setAnswers({});
    setError(null);
    setSuccess(false);
    onClose();
  }, [onClose]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const canProceed = Boolean(currentValue);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !success && handleSkip()}>
      <DialogContent
        className="sm:max-w-[64rem] gap-0 overflow-hidden rounded-3xl border-border/60 p-0 shadow-2xl"
        showCloseButton={!success}
        onPointerDownOutside={(e) => success && e.preventDefault()}
        onEscapeKeyDown={(e) => success && e.preventDefault()}
      >
        {success ? (
          <div className="relative flex min-h-[22rem] flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-br from-background via-background to-accent/25 px-6 py-10 text-center animate-in zoom-in-95 fade-in duration-200">
            <div className="absolute -top-12 -right-10 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
            <div className="absolute -bottom-12 -left-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
              <CheckCircle2 className="h-7 w-7 text-primary" />
            </div>
            <div className="relative">
              <DialogTitle className="text-xl">Thank you for your feedback</DialogTitle>
              <DialogDescription className="mt-2 text-muted-foreground">
                Your responses help us improve the product.
              </DialogDescription>
            </div>
          </div>
        ) : (
          <div className="grid min-h-[min(78vh,42rem)] grid-cols-1 md:grid-cols-[minmax(17rem,21rem)_1fr]">
            <aside className="relative overflow-hidden border-b border-border/60 bg-gradient-to-b from-zinc-100 via-zinc-50 to-white px-6 py-7 dark:from-zinc-900 dark:via-zinc-950 dark:to-black sm:px-8 sm:py-9 md:border-b-0 md:border-r">
              <div className="absolute -top-20 -left-12 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
              <div className="absolute -bottom-20 -right-16 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
              <div className="relative flex h-full flex-col">
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border/70 bg-background/75 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                  <MessageSquareQuote className="h-3.5 w-3.5 text-primary" />
                  Product survey
                </div>

                <div className="mt-7 space-y-3">
                  <h2 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
                    HelixDB user
                    <br />
                    experience survey
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Help us improve the workflow quality and polish of your daily database tasks.
                  </p>
                </div>

                <div className="mt-8 space-y-3">
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>Just {TOTAL_STEPS} multiple-choice questions.</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>No personal data collection.</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>Your feedback directly guides product priorities.</span>
                  </div>
                </div>

                <div className="mt-auto pt-8 text-xs text-muted-foreground/85">
                  Created for better product UX
                </div>
              </div>
            </aside>

            <section className="flex flex-col bg-background px-6 py-7 sm:px-9 sm:py-9">
              <div className="mb-7 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium text-muted-foreground">
                    Question {step + 1} of {TOTAL_STEPS}
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
                    <Sparkles className="h-3 w-3" />
                    {Math.round(progress)}% complete
                  </span>
                </div>

                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={step + 1}
                  aria-valuemin={1}
                  aria-valuemax={TOTAL_STEPS}
                  aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <DialogHeader className="gap-2 text-left">
                  <DialogTitle id="survey-question" className="text-xl leading-tight sm:text-2xl">
                    {question?.label}
                  </DialogTitle>
                  <DialogDescription className="text-sm text-muted-foreground">
                    Select the option that best describes your experience.
                  </DialogDescription>
                </DialogHeader>
              </div>

              <div
                role="radiogroup"
                aria-labelledby="survey-question"
                className="grid max-h-[48vh] gap-2.5 overflow-y-auto pr-1"
              >
                {question?.options.map((opt, idx) => {
                  const selected = currentValue === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={(!currentValue && idx === 0) || selected ? 0 : -1}
                      className={cn(
                        "group flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium transition-all outline-none",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        selected
                          ? "border-primary/70 bg-primary/10 text-foreground shadow-sm"
                          : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
                      )}
                      onClick={() => handleSelect(opt)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleSelect(opt);
                          return;
                        }
                        if (!question) return;
                        const maxIndex = question.options.length - 1;
                        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                          e.preventDefault();
                          const nextIndex = idx === maxIndex ? 0 : idx + 1;
                          handleSelect(question.options[nextIndex]);
                        }
                        if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          const prevIndex = idx === 0 ? maxIndex : idx - 1;
                          handleSelect(question.options[prevIndex]);
                        }
                      }}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                          selected ? "border-primary bg-primary" : "border-muted-foreground/40"
                        )}
                      >
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full bg-primary-foreground transition-transform",
                            selected ? "scale-100" : "scale-0"
                          )}
                        />
                      </span>
                      <span>{opt}</span>
                    </button>
                  );
                })}
              </div>

              {error && (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <div className="mt-auto flex items-center justify-between gap-3 pt-8">
                {step === 0 ? (
                  <Button
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={handleSkip}
                    disabled={submitting}
                  >
                    Skip for now
                  </Button>
                ) : (
                  <Button variant="outline" onClick={handleBack} disabled={submitting}>
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                )}

                <Button
                  className="min-w-[8.25rem]"
                  onClick={handleNext}
                  disabled={!canProceed || submitting}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isLastStep ? (
                    "Submit"
                  ) : (
                    <>
                      Continue
                      <ChevronRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
