"use client";

import { useState, useCallback } from "react";
import { useSchemaDesignerStore } from "@/stores/schema-designer-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Plus,
    Database,
    Trash2,
    Calendar,
    Table2,
    FolderOpen,
    FileUp,
} from "lucide-react";
import { ImportSqlDialog } from "./import-sql-dialog";
import { toast } from "sonner";

const APP_TYPES = [
    { value: "ecommerce", label: "eCommerce", icon: "🛒" },
    { value: "saas", label: "SaaS Platform", icon: "☁️" },
    { value: "social", label: "Social Network", icon: "👥" },
    { value: "crm", label: "CRM System", icon: "📊" },
    { value: "marketplace", label: "Marketplace", icon: "🏪" },
    { value: "cms", label: "CMS / Blog", icon: "📝" },
    { value: "fintech", label: "FinTech", icon: "💰" },
    { value: "healthcare", label: "Healthcare", icon: "🏥" },
    { value: "education", label: "EdTech", icon: "🎓" },
    { value: "custom", label: "Custom", icon: "🔧" },
];

export function ProjectList() {
    const { projects, createProject, deleteProject, setActiveProject } = useSchemaDesignerStore();
    const [showCreate, setShowCreate] = useState(false);
    const [newName, setNewName] = useState("");
    const [newAppType, setNewAppType] = useState("custom");
    const [newDescription, setNewDescription] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [showImportSql, setShowImportSql] = useState(false);

    const handleCreate = useCallback(async () => {
        if (!newName.trim()) return;
        setIsCreating(true);
        try {
            await createProject(newName.trim(), newAppType, newDescription.trim());
            setShowCreate(false);
            setNewName("");
            setNewAppType("custom");
            setNewDescription("");
            toast.success("Project created!");
        } catch {
            toast.error("Failed to create project");
        } finally {
            setIsCreating(false);
        }
    }, [newName, newAppType, newDescription, createProject]);

    const handleDelete = useCallback(async () => {
        if (!deleteId) return;
        try {
            await deleteProject(deleteId);
            setDeleteId(null);
            toast.success("Project deleted");
        } catch {
            toast.error("Failed to delete project");
        }
    }, [deleteId, deleteProject]);

    return (
        <div className="h-full overflow-y-auto">
            <div className="max-w-5xl mx-auto px-6 py-10">
                {/* Hero */}
                <div className="text-center mb-10">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-4">
                        <Database className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="text-xs font-medium text-emerald-500">AI Schema Designer</span>
                    </div>
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent mb-3">
                        Design your database schema
                    </h1>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        Plan and design PostgreSQL schemas with AI assistance.
                        Create tables, define relationships, and get performance insights.
                    </p>
                </div>

                {/* Create + Import */}
                <div className="flex justify-center gap-3 mb-8">
                    <Button
                        onClick={() => setShowCreate(true)}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/20"
                    >
                        <Plus className="h-4 w-4" />
                        New Project
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => setShowImportSql(true)}
                        className="gap-2 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                    >
                        <FileUp className="h-4 w-4" />
                        Import from SQL
                    </Button>
                </div>

                {/* Project grid */}
                {projects.length === 0 ? (
                    <div className="text-center py-20">
                        <FolderOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                        <p className="text-sm text-muted-foreground">
                            No projects yet. Create one to get started!
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {projects.map((project) => {
                            const appType = APP_TYPES.find(t => t.value === project.app_type);
                            return (
                                <button
                                    key={project.id}
                                    onClick={() => setActiveProject(project.id)}
                                    className="group relative text-left rounded-xl border border-border/30 bg-card/50 hover:bg-card/80 hover:border-emerald-500/30 p-5 transition-all duration-200 hover:shadow-lg hover:shadow-emerald-500/5"
                                >
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="text-2xl">{appType?.icon ?? "🔧"}</div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteId(project.id);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-all"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    <h3 className="font-semibold text-sm text-foreground mb-1 truncate">
                                        {project.name}
                                    </h3>
                                    {project.description && (
                                        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                                            {project.description}
                                        </p>
                                    )}
                                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                                        <span className="flex items-center gap-1">
                                            <Table2 className="h-3 w-3" />
                                            {project.tables.length} tables
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Calendar className="h-3 w-3" />
                                            {new Date(project.updated_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Create Dialog */}
            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create New Project</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                                Project Name
                            </label>
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="My Database Schema"
                                className="bg-muted/30"
                                autoFocus
                                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                                Application Type
                            </label>
                            <Select value={newAppType} onValueChange={setNewAppType}>
                                <SelectTrigger className="bg-muted/30">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {APP_TYPES.map((type) => (
                                        <SelectItem key={type.value} value={type.value}>
                                            <span className="flex items-center gap-2">
                                                <span>{type.icon}</span>
                                                <span>{type.label}</span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                                Description (optional)
                            </label>
                            <Input
                                value={newDescription}
                                onChange={(e) => setNewDescription(e.target.value)}
                                placeholder="Brief description of your app…"
                                className="bg-muted/30"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreate(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={!newName.trim() || isCreating}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            {isCreating ? "Creating…" : "Create"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ImportSqlDialog open={showImportSql} onOpenChange={setShowImportSql} hasActiveProject={false} />

            {/* Delete Confirmation Dialog */}
            <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete project?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        This action cannot be undone. All tables and version history will be permanently deleted.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteId(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
