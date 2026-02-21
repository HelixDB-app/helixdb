"use client";

import { useConnectionStore } from "@/stores/connection-store";
import { APP_NAME, APP_VERSION } from "@/lib/app-config";
import { Database } from "lucide-react";

const APP_LOGO = "/logo.png";

export function StatusBar() {
    const { isConnected, databaseName, serverVersion, selectedTable, selectedSchema } = useConnectionStore();

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? serverVersion.split(" ").slice(0, 2).join(" ")
        : "";

    return (
        <div className="flex h-6 items-center justify-between border-t border-border/15 bg-card/30 px-4 select-none shrink-0">
            <div className="flex items-center gap-3">
                {isConnected ? (
                    <>
                        <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            <span className="text-[10px] text-emerald-400/80 font-medium">
                                Connected
                            </span>
                        </div>
                        <div className="h-3 w-px bg-border/40" />
                        <div className="flex items-center gap-1">
                            <Database className="h-2.5 w-2.5 text-muted-foreground/40" />
                            <span className="text-[10px] text-muted-foreground/60 font-mono">
                                {databaseName}
                            </span>
                        </div>
                        {selectedTable && selectedSchema && (
                            <>
                                <div className="h-3 w-px bg-border/40" />
                                <span className="text-[10px] text-muted-foreground/50 font-mono">
                                    {selectedSchema}.{selectedTable}
                                </span>
                            </>
                        )}
                    </>
                ) : (
                    <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/20" />
                        <span className="text-[10px] text-muted-foreground/40">
                            Disconnected
                        </span>
                    </div>
                )}
            </div>

            <div className="flex items-center gap-3">
                {pgVersion && isConnected && (
                    <span className="text-[10px] font-mono text-muted-foreground/35">
                        PostgreSQL {pgVersion}
                    </span>
                )}
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/25 font-mono">
                    <img src={APP_LOGO} alt="" className="h-3.5 w-3.5 rounded object-contain opacity-80" />
                    {`${APP_NAME} v${APP_VERSION.split(".").slice(0, 2).join(".")}`}
                </span>
            </div>
        </div>
    );
}
