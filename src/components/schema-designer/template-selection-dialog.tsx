"use client";

import { useCallback, useMemo, useState } from "react";
import { BookOpen, Database, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import {
    filterTemplates,
    getSchemaTemplateCatalog,
    instantiateFullSchemaTemplate,
    instantiateModuleTemplate,
    type PreparedSchemaTemplate,
} from "@/lib/schema-templates";

type TemplateTab = "full" | "module";

interface TemplateSelectionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const catalog = getSchemaTemplateCatalog();

function categoryLabel(value: string): string {
    return value
        .split("_")
        .map(part => part[0]?.toUpperCase() + part.slice(1))
        .join(" ");
}

function TemplateCard({
    template,
    actionLabel,
    onAction,
}: {
    template: PreparedSchemaTemplate;
    actionLabel: string;
    onAction: (template: PreparedSchemaTemplate) => void;
}) {
    return (
        <div className="flex h-full flex-col rounded-xl border border-border/20 bg-card/30 p-4 transition-all hover:border-emerald-500/30 hover:bg-card/60">
            <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-foreground">{template.name}</h3>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {template.description}
                    </p>
                </div>
                <Badge variant="outline" className="shrink-0 border-border/30 text-[10px]">
                    {template.tableCount} tables
                </Badge>
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5">
                <Badge variant="secondary" className="text-[10px] font-medium">
                    {categoryLabel(template.category)}
                </Badge>
                {template.tags.slice(0, 3).map(tag => (
                    <Badge key={`${template.id}-${tag}`} variant="outline" className="text-[10px] text-muted-foreground">
                        {tag}
                    </Badge>
                ))}
            </div>

            <div className="mt-auto flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">{template.columnCount} columns</span>
                <Button
                    size="sm"
                    className="h-7 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                    onClick={() => onAction(template)}
                >
                    {actionLabel}
                </Button>
            </div>
        </div>
    );
}

export function TemplateSelectionDialog({ open, onOpenChange }: TemplateSelectionDialogProps) {
    const { getActiveProject, setTables } = useSchemaDesignerStore();
    const project = getActiveProject();

    const [tab, setTab] = useState<TemplateTab>("full");
    const [search, setSearch] = useState("");
    const [fullCategory, setFullCategory] = useState("all");
    const [moduleCategory, setModuleCategory] = useState("all");
    const [pendingReplace, setPendingReplace] = useState<PreparedSchemaTemplate | null>(null);

    const fullTemplates = useMemo(
        () => filterTemplates(catalog.full, search, fullCategory),
        [search, fullCategory]
    );

    const moduleTemplates = useMemo(
        () => filterTemplates(catalog.modules, search, moduleCategory),
        [search, moduleCategory]
    );

    const runFullTemplate = useCallback((template: PreparedSchemaTemplate) => {
        const result = instantiateFullSchemaTemplate(template);
        setTables(result.tables);
        onOpenChange(false);

        toast.success(`Applied \"${template.name}\" template`, {
            description: `${result.insertedCount} tables ready to edit.`,
        });

        if (result.unresolvedForeignKeys > 0) {
            toast.error(`${result.unresolvedForeignKeys} foreign keys could not be mapped.`);
        }
    }, [onOpenChange, setTables]);

    const handleApplyFull = useCallback((template: PreparedSchemaTemplate) => {
        if (!project) return;
        if (project.tables.length > 0) {
            setPendingReplace(template);
            return;
        }
        runFullTemplate(template);
    }, [project, runFullTemplate]);

    const handleInsertModule = useCallback((template: PreparedSchemaTemplate) => {
        if (!project) return;

        const result = instantiateModuleTemplate(template, project.tables);
        setTables([...project.tables, ...result.tables]);

        toast.success(`Inserted module: ${template.name}`, {
            description: `${result.insertedCount} tables added to this design.`,
        });

        if (result.renamedTables.length > 0) {
            toast.success(`${result.renamedTables.length} table names were adjusted to avoid conflicts.`);
        }

        if (result.unresolvedForeignKeys > 0) {
            toast.error(`${result.unresolvedForeignKeys} foreign keys could not be mapped.`);
        }
    }, [project, setTables]);

    if (!project) return null;

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="flex h-[82vh] max-h-[760px] w-[min(1080px,95vw)] max-w-[1080px] flex-col p-0">
                    <DialogHeader className="border-b border-border/20 px-5 py-4">
                        <DialogTitle className="flex items-center gap-2 text-base">
                            <Sparkles className="h-4 w-4 text-emerald-500" />
                            Template Selection
                        </DialogTitle>
                        <DialogDescription>
                            Start from full schemas or insert reusable modules into your current design.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4">
                        <Tabs value={tab} onValueChange={(value) => setTab(value as TemplateTab)} className="min-h-0 flex-1">
                            <div className="flex items-center gap-3 border-b border-border/15 pb-3">
                                <TabsList className="h-8 bg-muted/30">
                                    <TabsTrigger value="full" className="gap-1.5 text-xs">
                                        <Database className="h-3.5 w-3.5" />
                                        Full Schemas
                                    </TabsTrigger>
                                    <TabsTrigger value="module" className="gap-1.5 text-xs">
                                        <BookOpen className="h-3.5 w-3.5" />
                                        Modules
                                    </TabsTrigger>
                                </TabsList>

                                <div className="relative ml-auto w-full max-w-sm">
                                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                                    <Input
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        placeholder={tab === "full" ? "Search full schema templates..." : "Search module templates..."}
                                        className="h-8 pl-8 text-xs"
                                    />
                                </div>
                            </div>

                            <TabsContent value="full" className="mt-3 flex min-h-0 flex-1 flex-col">
                                <div className="mb-3 flex items-center gap-2">
                                    <label className="text-xs text-muted-foreground">Category</label>
                                    <select
                                        value={fullCategory}
                                        onChange={(event) => setFullCategory(event.target.value)}
                                        className="h-7 rounded-md border border-border/30 bg-muted/20 px-2.5 text-xs"
                                    >
                                        <option value="all">All categories</option>
                                        {catalog.fullCategories.map(category => (
                                            <option key={category} value={category}>{categoryLabel(category)}</option>
                                        ))}
                                    </select>
                                    <span className="ml-auto text-xs text-muted-foreground">{fullTemplates.length} templates</span>
                                </div>

                                <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/20">
                                    {fullTemplates.length === 0 ? (
                                        <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">
                                            No full schema templates match your search.
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 lg:grid-cols-3">
                                            {fullTemplates.map(template => (
                                                <TemplateCard
                                                    key={template.id}
                                                    template={template}
                                                    actionLabel="Apply Schema"
                                                    onAction={handleApplyFull}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </ScrollArea>
                            </TabsContent>

                            <TabsContent value="module" className="mt-3 flex min-h-0 flex-1 flex-col">
                                <div className="mb-3 flex items-center gap-2">
                                    <label className="text-xs text-muted-foreground">Category</label>
                                    <select
                                        value={moduleCategory}
                                        onChange={(event) => setModuleCategory(event.target.value)}
                                        className="h-7 rounded-md border border-border/30 bg-muted/20 px-2.5 text-xs"
                                    >
                                        <option value="all">All categories</option>
                                        {catalog.moduleCategories.map(category => (
                                            <option key={category} value={category}>{categoryLabel(category)}</option>
                                        ))}
                                    </select>
                                    <span className="ml-auto text-xs text-muted-foreground">{moduleTemplates.length} templates</span>
                                </div>

                                <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/20">
                                    {moduleTemplates.length === 0 ? (
                                        <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">
                                            No module templates match your search.
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 lg:grid-cols-3">
                                            {moduleTemplates.map(template => (
                                                <TemplateCard
                                                    key={template.id}
                                                    template={template}
                                                    actionLabel="Insert Module"
                                                    onAction={handleInsertModule}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </ScrollArea>
                            </TabsContent>
                        </Tabs>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={!!pendingReplace} onOpenChange={(open) => !open && setPendingReplace(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Replace current schema?</DialogTitle>
                        <DialogDescription>
                            This will replace the existing tables in this project with the selected full template.
                            You can still undo right after applying.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingReplace(null)}>
                            Cancel
                        </Button>
                        <Button
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            onClick={() => {
                                if (!pendingReplace) return;
                                runFullTemplate(pendingReplace);
                                setPendingReplace(null);
                            }}
                        >
                            Replace Schema
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
