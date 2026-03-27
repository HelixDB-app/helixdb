"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Quick-search webview uses a transparent Tauri window on macOS (`transparent` + `effects.radius`).
 * Clear root backgrounds so vibrancy and rounded corners are visible at the window edge.
 */
export default function DesktopSearchLayout({
    children,
}: Readonly<{
    children: ReactNode;
}>) {
    useEffect(() => {
        const html = document.documentElement;
        const body = document.body;
        const prevHtml = html.style.backgroundColor;
        const prevBody = html.style.backgroundColor;
        html.style.backgroundColor = "transparent";
        body.style.backgroundColor = "transparent";
        return () => {
            html.style.backgroundColor = prevHtml;
            body.style.backgroundColor = prevBody;
        };
    }, []);

    return children;
}
