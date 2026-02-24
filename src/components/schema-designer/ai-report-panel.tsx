"use client";

import { useState, useCallback } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { generateReport } from "@/lib/schema-designer-engine";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
    BarChart3,
    Loader2,
    AlertTriangle,
    CheckCircle2,
    Zap,
    TrendingUp,
    Database,
    Lightbulb,
    RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

interface AIReportPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function AIReportPanel({ open, onOpenChange }: AIReportPanelProps) {
    const {
        getActiveProject,
        currentReport,
        setCurrentReport,
        isReportLoading,
        setReportLoading,
    } = useSchemaDesignerStore();

    const project = getActiveProject();
    const [streamText, setStreamText] = useState("");

    const handleGenerate = useCallback(async () => {
        if (!project || project.tables.length === 0) return;

        setReportLoading(true);
        setCurrentReport(null);
        setStreamText("");

        try {
            const report = await generateReport(
                project.tables,
                (chunk) => setStreamText(prev => prev + chunk),
            );
            setCurrentReport(report);
            setStreamText("");
        } catch (err: any) {
            toast.error(err.message || "Failed to generate report");
        } finally {
            setReportLoading(false);
        }
    }, [project, setReportLoading, setCurrentReport]);

    const scoreColor = (score: number) => {
        if (score >= 80) return "text-emerald-500";
        if (score >= 60) return "text-yellow-500";
        return "text-red-500";
    };

    const ratingColor = (rating: string) => {
        if (rating === "Excellent") return "text-emerald-500 bg-emerald-500/10";
        if (rating === "Good") return "text-blue-500 bg-blue-500/10";
        if (rating === "Fair") return "text-yellow-500 bg-yellow-500/10";
        return "text-red-500 bg-red-500/10";
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <BarChart3 className="h-4 w-4 text-emerald-500" />
                        AI Performance Report
                    </DialogTitle>
                </DialogHeader>

                {!currentReport && !isReportLoading && (
                    <div className="text-center py-8">
                        <BarChart3 className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground mb-4">
                            Generate an AI-powered analysis of your schema&apos;s performance, scalability, and optimization opportunities.
                        </p>
                        <Button
                            onClick={handleGenerate}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                        >
                            <Zap className="h-4 w-4" />
                            Generate Report
                        </Button>
                    </div>
                )}

                {isReportLoading && (
                    <div className="py-8 space-y-4">
                        <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
                            <span className="text-sm text-muted-foreground">Analyzing schema…</span>
                        </div>
                        {streamText && (
                            <pre className="text-[10px] font-mono text-muted-foreground/60 whitespace-pre-wrap bg-muted/20 rounded-lg p-3 max-h-40 overflow-y-auto">
                                {streamText}
                            </pre>
                        )}
                    </div>
                )}

                {currentReport && !isReportLoading && (
                    <div className="space-y-4">
                        {/* Score + Rating */}
                        <div className="flex items-center gap-4">
                            <div className="flex-1 text-center rounded-lg border border-border/20 bg-muted/10 p-4">
                                <div className={`text-3xl font-bold ${scoreColor(currentReport.performance_score)}`}>
                                    {currentReport.performance_score}
                                </div>
                                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">
                                    Performance Score
                                </div>
                            </div>
                            <div className="flex-1 text-center rounded-lg border border-border/20 bg-muted/10 p-4">
                                <div className={`text-sm font-bold px-3 py-1 rounded-full inline-block ${ratingColor(currentReport.scalability_rating)}`}>
                                    {currentReport.scalability_rating}
                                </div>
                                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-2">
                                    Scalability
                                </div>
                            </div>
                        </div>

                        {/* Summary */}
                        <div className="rounded-lg border border-border/20 bg-muted/10 p-3">
                            <p className="text-xs text-foreground">{currentReport.summary}</p>
                        </div>

                        {/* Estimated Load */}
                        <div className="flex items-start gap-2 rounded-lg border border-border/20 bg-muted/10 p-3">
                            <TrendingUp className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                            <div>
                                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Estimated Load Capacity</div>
                                <p className="text-xs text-foreground">{currentReport.estimated_load}</p>
                            </div>
                        </div>

                        {/* Bottlenecks */}
                        {currentReport.bottlenecks.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                                    Potential Bottlenecks
                                </h4>
                                <div className="space-y-1.5">
                                    {currentReport.bottlenecks.map((b, i) => (
                                        <div key={i} className="text-xs text-muted-foreground bg-yellow-500/5 border border-yellow-500/10 rounded-md p-2">
                                            {b}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Index Suggestions */}
                        {currentReport.index_suggestions.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                                    <Database className="h-3.5 w-3.5 text-emerald-500" />
                                    Index Suggestions
                                </h4>
                                <div className="space-y-1.5">
                                    {currentReport.index_suggestions.map((s, i) => (
                                        <div key={i} className="text-xs text-muted-foreground bg-emerald-500/5 border border-emerald-500/10 rounded-md p-2 font-mono">
                                            {s}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Architecture Notes */}
                        {currentReport.architecture_notes.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                                    <Lightbulb className="h-3.5 w-3.5 text-blue-500" />
                                    Architecture Recommendations
                                </h4>
                                <div className="space-y-1.5">
                                    {currentReport.architecture_notes.map((n, i) => (
                                        <div key={i} className="text-xs text-muted-foreground bg-blue-500/5 border border-blue-500/10 rounded-md p-2">
                                            {n}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Regenerate */}
                        <div className="flex justify-center pt-2">
                            <Button variant="outline" size="sm" onClick={handleGenerate} className="gap-1.5 text-xs">
                                <RefreshCw className="h-3 w-3" />
                                Regenerate Report
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
