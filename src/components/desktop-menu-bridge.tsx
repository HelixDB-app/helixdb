"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { isTauriRuntime } from "@/lib/runtime";
import { useUpdateStore } from "@/stores/update-store";

const Q_DESKTOP = "pgstudio_desktop";
const Q_SECTION = "pgstudio_section";

function pushHomeDesktop(router: ReturnType<typeof useRouter>, desktop: string, section?: string) {
    const params = new URLSearchParams();
    params.set(Q_DESKTOP, desktop);
    if (section) params.set(Q_SECTION, section);
    router.push(`/?${params.toString()}`);
}

/**
 * Subscribes to native menubar events from the Tauri host (macOS / Windows / Linux)
 * and routes them into Next.js navigation, settings, updates, and the system browser.
 */
export function DesktopMenuBridge() {
    const router = useRouter();
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;

    useEffect(() => {
        if (!isTauriRuntime()) return;

        const unlistenFns: Array<() => void> = [];

        void (async () => {
            try {
                unlistenFns.push(
                    await listen<string>("pgstudio-menu-navigate", (event) => {
                        const path = event.payload;
                        const cur = pathnameRef.current;
                        if (path === cur) {
                            router.refresh();
                            return;
                        }
                        router.push(path);
                    })
                );

                unlistenFns.push(
                    await listen<string>("pgstudio-menu-action", (event) => {
                        const action = event.payload;

                        switch (action) {
                            case "check-updates":
                                void useUpdateStore.getState().checkForUpdates({ source: "manual" });
                                break;
                            case "open-settings":
                                pushHomeDesktop(router, "settings");
                                break;
                            case "open-settings-about":
                                pushHomeDesktop(router, "settings", "about");
                                break;
                            case "open-settings-shortcuts":
                                pushHomeDesktop(router, "settings", "shortcuts");
                                break;
                            case "open-command-palette":
                                pushHomeDesktop(router, "palette");
                                break;
                            default:
                                break;
                        }
                    })
                );

                unlistenFns.push(
                    await listen<{ url: string }>("pgstudio-open-external", async (event) => {
                        try {
                            await open(event.payload.url);
                        } catch {
                            // ignore — user may have cancelled or shell blocked
                        }
                    })
                );
            } catch {
                // Non-desktop or listener unavailable
            }
        })();

        return () => {
            for (const u of unlistenFns) {
                u();
            }
        };
    }, [router]);

    return null;
}
