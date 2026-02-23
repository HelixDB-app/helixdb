"use client";

import { Component, type ReactNode } from "react";
import { logException } from "@/lib/firebase";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches React tree errors, reports them to Firebase Analytics (non-fatal), then shows fallback or rethrows.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const description =
      [error.message, errorInfo.componentStack].filter(Boolean).join("\n") ||
      String(error);
    logException(description, false);
  }

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex min-h-[200px] items-center justify-center p-6 text-center text-muted-foreground">
          <p>Something went wrong. The error has been reported.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
