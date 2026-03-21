"use client";

import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  submitBetaFeedback,
  type BetaFeedbackCategory,
} from "@/lib/beta-feedback";
import type { SurveyTokenGetter } from "@/lib/survey";
import { APP_VERSION } from "@/lib/app-config";
import {
  markBetaFeedbackDismissForever,
  markBetaFeedbackNotNowSession,
  markBetaFeedbackSubmitted,
} from "@/lib/beta-feedback-storage";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

const CATEGORY_LABELS: Record<BetaFeedbackCategory, string> = {
  general: "General feedback",
  idea: "Idea",
  bug: "Bug / issue",
  feature: "Feature request",
};

function isValidEmail(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

interface BetaFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getToken?: SurveyTokenGetter;
}

export function BetaFeedbackDialog({
  open,
  onOpenChange,
  getToken,
}: BetaFeedbackDialogProps) {
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<BetaFeedbackCategory>("general");
  const [contactEmail, setContactEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setMessage("");
    setCategory("general");
    setContactEmail("");
    setError(null);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next && !submitting) resetForm();
      onOpenChange(next);
    },
    [onOpenChange, submitting, resetForm]
  );

  const handleNotNow = useCallback(() => {
    markBetaFeedbackNotNowSession();
    resetForm();
    onOpenChange(false);
  }, [onOpenChange, resetForm]);

  const handleNever = useCallback(() => {
    markBetaFeedbackDismissForever();
    resetForm();
    onOpenChange(false);
  }, [onOpenChange, resetForm]);

  const handleSubmit = useCallback(async () => {
    const trimmed = message.trim();
    if (trimmed.length < MESSAGE_MIN) {
      setError(`Please enter at least ${MESSAGE_MIN} characters.`);
      return;
    }
    if (trimmed.length > MESSAGE_MAX) {
      setError(`Message must be at most ${MESSAGE_MAX} characters.`);
      return;
    }
    if (!isValidEmail(contactEmail)) {
      setError("Please enter a valid email or leave the field empty.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await submitBetaFeedback(
        {
          message: trimmed,
          category,
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
          appVersion: APP_VERSION,
          platform: typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown",
          clientLocale: typeof navigator !== "undefined" ? navigator.language : undefined,
        },
        { getToken }
      );
      markBetaFeedbackSubmitted();
      toast.success("Thank you — your feedback was sent.");
      resetForm();
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong. Please try again.";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [message, category, contactEmail, getToken, onOpenChange, resetForm]);

  const trimmedLen = message.trim().length;
  const canSubmit =
    trimmedLen >= MESSAGE_MIN && trimmedLen <= MESSAGE_MAX && isValidEmail(contactEmail);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          "sm:max-w-[28rem] gap-0 overflow-hidden rounded-2xl border-border/60 p-0 shadow-xl"
        )}
        showCloseButton={!submitting}
        onPointerDownOutside={(e) => submitting && e.preventDefault()}
        onEscapeKeyDown={(e) => submitting && e.preventDefault()}
      >
        <div className="relative border-b border-border/50 bg-muted/30 px-6 py-5">
          <div className="absolute -top-16 -right-10 h-32 w-32 rounded-full bg-primary/10 blur-2xl" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogHeader className="space-y-1.5 text-left p-0">
                <DialogTitle className="text-lg font-semibold tracking-tight">
                  We&apos;re in beta
                </DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground leading-relaxed">
                  Thanks for using the app — we&apos;re actively building the next releases. Share
                  feedback, ideas, feature requests, or report bugs; it directly helps us improve.
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-2">
            <Label htmlFor="beta-feedback-category" className="text-xs text-muted-foreground">
              Type
            </Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as BetaFeedbackCategory)}
              disabled={submitting}
            >
              <SelectTrigger id="beta-feedback-category" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CATEGORY_LABELS) as BetaFeedbackCategory[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {CATEGORY_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="beta-feedback-message" className="text-xs text-muted-foreground">
              Your message
            </Label>
            <Textarea
              id="beta-feedback-message"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setError(null);
              }}
              disabled={submitting}
              placeholder="What would you like us to know?"
              className="min-h-[120px] resize-y text-sm"
              maxLength={MESSAGE_MAX}
            />
            <p className="text-[11px] text-muted-foreground text-right">
              {trimmedLen} / {MESSAGE_MAX}
              {trimmedLen < MESSAGE_MIN && trimmedLen > 0 ? ` (min ${MESSAGE_MIN})` : ""}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="beta-feedback-email" className="text-xs text-muted-foreground">
              Contact email <span className="font-normal">(optional)</span>
            </Label>
            <Input
              id="beta-feedback-email"
              type="email"
              value={contactEmail}
              onChange={(e) => {
                setContactEmail(e.target.value);
                setError(null);
              }}
              disabled={submitting}
              placeholder="you@example.com"
              className="h-9 text-sm"
              autoComplete="email"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col gap-2 border-t border-border/50 bg-muted/20 px-6 py-4 sm:flex-col">
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={submitting}
              onClick={handleNotNow}
            >
              Not now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto text-muted-foreground"
              disabled={submitting}
              onClick={handleNever}
            >
              Don&apos;t show again
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              disabled={!canSubmit || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Sending…
                </>
              ) : (
                "Send feedback"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
