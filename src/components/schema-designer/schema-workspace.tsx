"use client";

import { useState, useCallback } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { TableEditor } from "./table-editor";
import { SchemaDiagram } from "./schema-diagram";
import { AISchemaPanel } from "./ai-schema-panel";
import { AIReportPanel } from "./ai-report-panel";
import { SchemaExport } from "./schema-export";
import { Button } from "@/components/ui/button";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Badge } from "@/components/ui/badge";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Table2,
    Network,
    BookOpen,
    FileDown,
    Undo2,
    Redo2,
    Save,
    BarChart3,
    Bot,
    Hand,
    History,
    FileUp,
    Code2,
} from "lucide-react";
import { ImportSqlDialog } from "./import-sql-dialog";
import { AIScriptPanel } from "./ai-script-panel";
import { SchemaScriptPanel } from "./schema-script-panel";
import { TemplateSelectionDialog } from "./template-selection-dialog";
import { toast } from "sonner";

type RightPanelTab = "ai" | "script";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

type WorkspaceView = "editor" | "diagram";

export function SchemaWorkspace() {
    const {
        getActiveProject,
        aiEnabled,
        setAiEnabled,
        undoStack,
        redoStack,
        undo,
        redo,
        saveSnapshot,
    } = useSchemaDesignerStore();

    const project = getActiveProject();

    const [view, setView] = useState<WorkspaceView>("editor");
    const [showExport, setShowExport] = useState(false);
    const [showReport, setShowReport] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [showImportSql, setShowImportSql] = useState(false);
    const [showTemplates, setShowTemplates] = useState(false);
    const [showAiScript, setShowAiScript] = useState(false);
    const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
    const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("ai");

    const handleSaveSnapshot = useCallback(() => {
        const label = `v${(project?.version_history.length ?? 0) + 1} — ${new Date().toLocaleString()}`;
        saveSnapshot(label);
        toast.success("Snapshot saved!");
    }, [project, saveSnapshot]);

    if (!project) return null;

    return (
        <div className="h-full flex flex-col">
            {/* Toolbar */}
            <div className="flex items-center justify-between border-b border-border/20 bg-card/10 px-3 py-1.5 shrink-0">
                <div className="flex items-center gap-2">
                    {/* View toggle */}
                    <div className="flex items-center rounded-md bg-muted/40 p-0.5">
                        <button
                            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${view === "editor"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            onClick={() => setView("editor")}
                        >
                            <Table2 className="h-3 w-3" />
                            Tables
                        </button>
                        <button
                            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-all ${view === "diagram"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            onClick={() => setView("diagram")}
                        >
                            <Network className="h-3 w-3" />
                            Diagram
                        </button>
                    </div>

                    <div className="h-4 w-px bg-border/30" />

                    {/* Table count */}
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-border/30 text-muted-foreground/60">
                        {project.tables.length} tables
                    </Badge>

                    {/* Undo/Redo */}
                    <div className="flex items-center gap-0.5">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    disabled={undoStack.length === 0}
                                    onClick={undo}
                                >
                                    <Undo2 className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Undo (⌘Z)</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    disabled={redoStack.length === 0}
                                    onClick={redo}
                                >
                                    <Redo2 className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Redo (⌘⇧Z)</TooltipContent>
                        </Tooltip>
                    </div>
                </div>

                <div className="flex items-center gap-1.5">
                    {/* AI toggle */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant={aiEnabled ? "default" : "outline"}
                                size="sm"
                                className={`h-7 gap-1.5 text-xs ${aiEnabled
                                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                                    : "text-muted-foreground"
                                    }`}
                                onClick={() => setAiEnabled(!aiEnabled)}
                            >
                                {aiEnabled ? <Bot className="h-3 w-3" /> : <Hand className="h-3 w-3" />}
                                {aiEnabled ? "AI On" : "Manual"}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {aiEnabled ? "Switch to manual mode" : "Enable AI assistance"}
                        </TooltipContent>
                    </Tooltip>

                    {/* Import SQL */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={() => setShowImportSql(true)}
                            >
                                <FileUp className="h-3 w-3" />
                                Import SQL
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Convert SQL script to schema</TooltipContent>
                    </Tooltip>

                    {/* Templates */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={() => setShowTemplates(true)}
                            >
                                <BookOpen className="h-3 w-3" />
                                Templates
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Apply full schemas or insert modules</TooltipContent>
                    </Tooltip>

                    {/* AI Generate Script */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={() => setShowAiScript(true)}
                            >
                                <Code2 className="h-3 w-3" />
                                AI Script
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Generate PostgreSQL with Gemini</TooltipContent>
                    </Tooltip>

                    {/* Report */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={() => setShowReport(true)}
                                disabled={project.tables.length === 0}
                            >
                                <BarChart3 className="h-3 w-3" />
                                Report
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>AI Performance Report</TooltipContent>
                    </Tooltip>

                    {/* Save snapshot */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={handleSaveSnapshot}
                            >
                                <Save className="h-3 w-3" />
                                Snapshot
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Save version snapshot</TooltipContent>
                    </Tooltip>

                    {/* History */}
                    {project.version_history.length > 0 && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5 text-xs text-muted-foreground"
                                    onClick={() => setShowHistory(true)}
                                >
                                    <History className="h-3 w-3" />
                                    {project.version_history.length}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Version history</TooltipContent>
                        </Tooltip>
                    )}

                    {/* Export */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1.5 text-xs text-muted-foreground"
                                onClick={() => setShowExport(true)}
                                disabled={project.tables.length === 0}
                            >
                                <FileDown className="h-3 w-3" />
                                Export
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Export schema</TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
                {aiEnabled ? (
                    <ResizablePanelGroup>
                        <ResizablePanel defaultSize={65} minSize={40}>
                            <div className="h-full">
                                {view === "editor" ? (
                                    <TableEditor
                                        selectedTableId={selectedTableId}
                                        onSelectTable={setSelectedTableId}
                                    />
                                ) : (
                                    <SchemaDiagram
                                        onSelectTable={setSelectedTableId}
                                    />
                                )}
                            </div>
                        </ResizablePanel>
                        <ResizableHandle className="w-px bg-border/20 hover:bg-emerald-500/40 transition-colors" />
                        <ResizablePanel defaultSize={35} minSize={25} maxSize={400}>
                            <div className="flex border-b border-border/20 bg-card/5 shrink-0">
                                <button
                                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${rightPanelTab === "ai"
                                        ? "text-foreground border-b-2 border-emerald-500 bg-emerald-500/5"
                                        : "text-muted-foreground hover:text-foreground"
                                        }`}
                                    onClick={() => setRightPanelTab("ai")}
                                >
                                    AI Assistant
                                </button>
                                <button
                                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${rightPanelTab === "script"
                                        ? "text-foreground border-b-2 border-emerald-500 bg-emerald-500/5"
                                        : "text-muted-foreground hover:text-foreground"
                                        }`}
                                    onClick={() => setRightPanelTab("script")}
                                >
                                    Script
                                </button>
                            </div>
                            <div className="flex-1 min-h-0 overflow-hidden">
                                {rightPanelTab === "ai" ? (
                                    <AISchemaPanel />
                                ) : (
                                    <SchemaScriptPanel isActive={rightPanelTab === "script"} />
                                )}
                            </div>
                        </ResizablePanel>
                    </ResizablePanelGroup>
                ) : (
                    <div className="h-full">
                        {view === "editor" ? (
                            <TableEditor
                                selectedTableId={selectedTableId}
                                onSelectTable={setSelectedTableId}
                            />
                        ) : (
                            <SchemaDiagram
                                onSelectTable={setSelectedTableId}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* Export Dialog */}
            <SchemaExport open={showExport} onOpenChange={setShowExport} />

            {/* Report Dialog */}
            <AIReportPanel open={showReport} onOpenChange={setShowReport} />

            <ImportSqlDialog open={showImportSql} onOpenChange={setShowImportSql} hasActiveProject={true} />

            <TemplateSelectionDialog open={showTemplates} onOpenChange={setShowTemplates} />

            <AIScriptPanel open={showAiScript} onOpenChange={setShowAiScript} />

            {/* History Dialog */}
            <VersionHistoryDialog open={showHistory} onOpenChange={setShowHistory} />
        </div>
    );
}

// ── Version History Dialog ───────────────────────────────────────────────────

function VersionHistoryDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { getActiveProject, restoreSnapshot } = useSchemaDesignerStore();
    const project = getActiveProject();

    if (!project) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md max-h-[70vh]">
                <DialogHeader>
                    <DialogTitle>Version History</DialogTitle>
                </DialogHeader>
                <div className="overflow-y-auto space-y-2">
                    {project.version_history.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">
                            No snapshots saved yet.
                        </p>
                    ) : (
                        [...project.version_history].reverse().map((snapshot) => (
                            <div
                                key={snapshot.id}
                                className="flex items-center justify-between rounded-lg border border-border/20 bg-muted/20 p-3"
                            >
                                <div>
                                    <p className="text-sm font-medium">{snapshot.label}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {snapshot.tables.length} tables • {new Date(snapshot.timestamp).toLocaleString()}
                                    </p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => {
                                        restoreSnapshot(snapshot.id);
                                        onOpenChange(false);
                                        toast.success("Snapshot restored!");
                                    }}
                                >
                                    Restore
                                </Button>
                            </div>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
