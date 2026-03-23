/**
 * PostHog client init + AI invocation capture + error tracking.
 * Init runs from PosthogAppProvider; capture is fire-and-forget (SDK batches sends).
 */

import type { Properties } from "posthog-js";
import posthog from "posthog-js";

import { APP_CHANNEL, APP_VERSION } from "@/lib/app-config";

let posthogReady = false;

export type AiModelInvocationProperties = {
    provider: string;
    model_id: string;
    feature: string;
    endpoint: string;
    latency_ms: number;
    status: string;
    stream?: boolean;
    cached?: boolean;
    error_message?: string;
};

const ERR_TRUNCATE = 200;

function truncateError(msg: string): string {
    if (msg.length <= ERR_TRUNCATE) return msg;
    return `${msg.slice(0, ERR_TRUNCATE)}…`;
}

export function isPosthogConfigured(): boolean {
    return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim());
}

export function isPosthogReady(): boolean {
    return posthogReady;
}

/** Idempotent. Call from PosthogAppProvider and optionally before capture. */
export function initPosthog(): void {
    if (typeof window === "undefined" || posthogReady) return;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
    if (!key) return;
    if (
        process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV !== "true"
    ) {
        return;
    }

    posthog.init(key, {
        api_host:
            process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
        capture_pageview: false,
        disable_session_recording: true,
        persistence: "localStorage",
        person_profiles: "identified_only",
        capture_exceptions: true,
        logs: {
            captureConsoleLogs: false,
        },
    });
    posthogReady = true;
}

export function captureAiModelInvocation(
    properties: AiModelInvocationProperties
): void {
    if (typeof window === "undefined") return;
    if (!isPosthogConfigured()) return;
    if (
        process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV !== "true"
    ) {
        return;
    }
    initPosthog();
    if (!posthogReady) return;

    const payload: Record<string, string | number | boolean | undefined> = {
        provider: properties.provider,
        model_id: properties.model_id,
        feature: properties.feature,
        endpoint: properties.endpoint,
        latency_ms: properties.latency_ms,
        status: properties.status,
    };
    if (properties.stream !== undefined) payload.stream = properties.stream;
    if (properties.cached !== undefined) payload.cached = properties.cached;
    if (properties.error_message) {
        payload.error_message = truncateError(properties.error_message);
    }

    posthog.capture("ai_model_invocation", payload);
}

const STACK_MAX = 2000;

function truncateStack(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
}

/**
 * Report a caught or synthetic error to PostHog Error Tracking ($exception).
 * No console output; safe to call from error boundaries and try/catch.
 */
export function capturePosthogException(
    error: unknown,
    additional?: Properties
): void {
    if (typeof window === "undefined") return;
    if (!isPosthogConfigured()) return;
    if (
        process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV !== "true"
    ) {
        return;
    }
    initPosthog();
    if (!posthogReady) return;

    try {
        const props: Properties = {
            app_version: APP_VERSION,
            app_channel: APP_CHANNEL,
            ...additional,
        };
        if (typeof props.react_component_stack === "string") {
            props.react_component_stack = truncateStack(
                props.react_component_stack,
                STACK_MAX
            );
        }
        posthog.captureException(error, props);
    } catch {
        // Never surface analytics failures
    }
}

export { posthog };
