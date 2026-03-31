"use client";

import Image from "next/image";
import Link from "next/link";
import { PgRuntimeConfigPanel } from "@/components/pg-runtime-config-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { APP_NAME } from "@/lib/app-config";
import { useConnectionStore } from "@/stores/connection-store";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";

export default function PgRuntimeConfigPage() {
    const { isConnected, connectionId, databaseName, disconnect } = useConnectionStore();

    if (!isConnected || !connectionId) {
        return (
            <div className="flex h-screen items-center justify-center bg-transparent px-6">
                <div className="w-full max-w-md rounded-2xl border border-border/40 bg-card/40 p-6 text-center">
                    <SlidersHorizontal className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                    <h1 className="text-lg font-semibold">No active database connection</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Connect from the workspace to explore live server configuration for this cluster.
                    </p>
                    <Button asChild className="mt-5">
                        <Link href="/">Back to workspace</Link>
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-transparent text-foreground">
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-28 -right-28 h-80 w-80 rounded-full bg-violet-500/5 blur-3xl" />
                <div className="absolute -bottom-32 -left-28 h-80 w-80 rounded-full bg-fuchsia-500/5 blur-3xl" />
            </div>

            <header className="sticky top-0 z-20 border-b border-border/35 bg-card/75 backdrop-blur-md dark:bg-background/90">
                <div className="mx-auto flex h-12 max-w-[1600px] items-center justify-between px-4">
                    <div className="flex items-center gap-3">
                        <Image
                            src="/logo.png"
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded-md object-contain"
                        />
                        <div className="flex items-center gap-2">
                            <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-sm font-bold text-transparent">
                                {APP_NAME}
                            </span>
                            <span className="hidden text-xs text-muted-foreground/80 sm:inline">Runtime Config Studio</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge
                            variant="outline"
                            className="hidden h-6 border-border/40 px-2 font-mono text-[10px] sm:inline-flex"
                        >
                            {databaseName}
                        </Badge>
                        <Button variant="ghost" size="sm" asChild className="h-7 px-2.5 text-xs">
                            <Link href="/">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Workspace
                            </Link>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => disconnect(connectionId)}
                        >
                            Disconnect
                        </Button>
                    </div>
                </div>
            </header>

            <main className="relative z-10">
                <PgRuntimeConfigPanel />
            </main>
        </div>
    );
}
