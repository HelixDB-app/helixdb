"use client";

import { useEffect, useState, useCallback } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { APP_NAME } from "@/lib/app-config";
import { ArrowLeft, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectList } from "@/components/schema-designer/project-list";
import { SchemaWorkspace } from "@/components/schema-designer/schema-workspace";

export default function SchemaDesignerPage() {
    const {
        activeProjectId,
        isLoading,
        error,
        loadProjects,
        setActiveProject,
        setError,
    } = useSchemaDesignerStore();

    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        setHydrated(true);
        loadProjects();
    }, [loadProjects]);

    const handleRetry = useCallback(() => {
        setError(null);
        loadProjects();
    }, [setError, loadProjects]);

    // SSR skeleton
    if (!hydrated) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
                    <p className="text-sm text-muted-foreground">Loading Schema Designer…</p>
                </div>
            </div>
        );
    }

    // Error state
    if (error && !isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4 max-w-md text-center">
                    <div className="h-12 w-12 rounded-full bg-red-500/10 flex items-center justify-center">
                        <AlertTriangle className="h-6 w-6 text-red-500" />
                    </div>
                    <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <Button onClick={handleRetry} variant="outline" className="gap-2">
                        <RefreshCw className="h-4 w-4" />
                        Retry
                    </Button>
                </div>
            </div>
        );
    }

    // Loading state
    if (isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <div className="relative">
                        <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping" />
                        <Loader2 className="h-8 w-8 animate-spin text-emerald-500 relative z-10" />
                    </div>
                    <p className="text-sm text-muted-foreground animate-pulse">Loading projects…</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-screen flex-col bg-background">
            {/* Header */}
            <header className="flex h-11 items-center justify-between border-b border-border/20 bg-card/20 px-3 shrink-0">
                <div className="flex items-center gap-2.5">
                    <a href="/" className="flex items-center gap-2 group">
                        <img src="/logo.png" alt="" className="h-6 w-6 rounded-md object-contain shrink-0" />
                        <span className="font-bold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            {APP_NAME}
                        </span>
                    </a>
                    <div className="h-4 w-px bg-border/40" />
                    <span className="text-xs font-medium text-muted-foreground">Schema Designer</span>

                    {activeProjectId && (
                        <>
                            <div className="h-4 w-px bg-border/40" />
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => setActiveProject(null)}
                            >
                                <ArrowLeft className="h-3 w-3" />
                                Projects
                            </Button>
                        </>
                    )}
                </div>
            </header>

            {/* Main content */}
            <div className="flex-1 overflow-hidden">
                {activeProjectId ? <SchemaWorkspace /> : <ProjectList />}
            </div>
        </div>
    );
}
