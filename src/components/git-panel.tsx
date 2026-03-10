"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { DiffEditor } from "@monaco-editor/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useGitStore } from "@/stores/git-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useIdeFsStore } from "@/stores/ide-fs-store";
import { useShortcutsStore } from "@/stores/shortcuts-store";
import { useSettingsStore } from "@/stores/settings-store";
import { githubCreateRepo } from "@/lib/tauri";
import { generateAiCommitMessage } from "@/lib/git-ai";
import { eventMatchesCombo, formatShortcut, isEditableTarget } from "@/lib/shortcut-keys";
import type { GithubRepo } from "@/lib/tauri";
import type { GitFileStatus } from "@/stores/git-store";
import { GithubAuthDialog } from "@/components/github-auth-dialog";
import { CreatePrDialog } from "@/components/create-pr-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
    GitBranch as GitBranchIcon,
    GitCommit,
    Plus,
    Minus,
    RefreshCw,
    Upload,
    Download,
    Sparkles,
    ChevronDown,
    ChevronRight,
    FolderOpen,
    AlertCircle,
    Check,
    X,
    RotateCcw,
    Loader2,
    GitPullRequest,
    Github,
    Settings,
    CloudUpload,
    FolderSync,
    LogOut,
} from "lucide-react";

// ── File status helpers ───────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    untracked: "U",
    renamed: "R",
};

const STATUS_COLORS: Record<string, string> = {
    added: "text-emerald-400",
    modified: "text-amber-400",
    deleted: "text-red-400",
    untracked: "text-sky-400",
    renamed: "text-purple-400",
};

type GitActionKind = "commit" | "push";

interface GitActionErrorHelp {
    title: string;
    summary: string;
    fixes: string[];
    technical: string;
}

function explainGitActionError(raw: string, action: GitActionKind): GitActionErrorHelp {
    const text = (raw || "Unknown error").trim();
    const msg = text.toLowerCase();

    if (action === "commit") {
        if (msg.includes("author not configured") || msg.includes("unable to auto-detect email address")) {
            return {
                title: "Git author is not configured",
                summary: "Git needs your name and email before it can create a commit.",
                fixes: [
                    "Open Git Settings in this panel.",
                    "Set your name and email.",
                    "Try commit again.",
                ],
                technical: text,
            };
        }
        if (msg.includes("nothing to commit")) {
            return {
                title: "Nothing to commit",
                summary: "There are no staged changes in the index.",
                fixes: [
                    "Stage one or more files from Changes.",
                    "Verify files appear in the Staged section.",
                    "Run commit again.",
                ],
                technical: text,
            };
        }
        return {
            title: "Commit failed",
            summary: "Git could not create the commit with the current input.",
            fixes: [
                "Check that your commit message is valid and files are staged.",
                "Confirm Git author name/email in settings.",
                "Retry commit.",
            ],
            technical: text,
        };
    }

    if (msg.includes("not authenticated") || msg.includes("bad credentials") || msg.includes("authentication failed") || msg.includes("401")) {
        return {
            title: "GitHub authentication failed",
            summary: "Your GitHub token is missing, expired, or invalid.",
            fixes: [
                "Reconnect GitHub from the Git panel.",
                "Try push again after reconnecting.",
            ],
            technical: text,
        };
    }
    if (msg.includes("repository not found") || msg.includes("permission denied") || msg.includes("403")) {
        return {
            title: "No access to repository",
            summary: "GitHub rejected the push because repository access failed.",
            fixes: [
                "Verify the remote URL points to the correct repo.",
                "Ensure your GitHub account has write access.",
                "Try push again.",
            ],
            technical: text,
        };
    }
    if (msg.includes("non-fast-forward") || msg.includes("fetch first") || msg.includes("tip of your current branch is behind")) {
        return {
            title: "Push rejected (branch behind remote)",
            summary: "Remote has newer commits. You need to sync before pushing.",
            fixes: [
                "Pull/rebase latest changes from remote branch.",
                "Resolve conflicts if prompted.",
                "Push again after branch is up to date.",
            ],
            technical: text,
        };
    }
    if (msg.includes("protected branch") || msg.includes("hook declined") || msg.includes("cannot force-push")) {
        return {
            title: "Branch protection blocked push",
            summary: "Repository rules prevent direct push to this branch.",
            fixes: [
                "Create a feature branch and push that branch.",
                "Open a Pull Request to merge changes.",
                "Ask repo admin if branch policy needs adjustment.",
            ],
            technical: text,
        };
    }
    if (msg.includes("could not resolve host") || msg.includes("connection timed out") || msg.includes("failed to connect")) {
        return {
            title: "Network error while pushing",
            summary: "The app could not reach GitHub.",
            fixes: [
                "Check internet connection or VPN/proxy settings.",
                "Retry push after network is stable.",
            ],
            technical: text,
        };
    }
    if (msg.includes("no remote") || msg.includes("remote not configured")) {
        return {
            title: "Remote repository is not configured",
            summary: "Git needs an origin remote URL before pushing.",
            fixes: [
                "Set remote URL in Git Settings or use Publish.",
                "Retry push after remote is configured.",
            ],
            technical: text,
        };
    }

    return {
        title: "Push failed",
        summary: "GitHub rejected the push or Git could not complete it.",
        fixes: [
            "Review remote URL and branch status.",
            "Check GitHub authentication and permissions.",
            "Retry push.",
        ],
        technical: text,
    };
}

function FileStatusBadge({ status }: { status: string }) {
    return (
        <span className={cn("font-mono text-[10px] font-bold w-3 text-right shrink-0", STATUS_COLORS[status] ?? "text-muted-foreground")}>
            {STATUS_LABELS[status] ?? "?"}
        </span>
    );
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({
    file,
    isSelected,
    onSelect,
    onStage,
    onUnstage,
    onDiscard,
}: {
    file: GitFileStatus;
    isSelected: boolean;
    onSelect: () => void;
    onStage: () => void;
    onUnstage: () => void;
    onDiscard: () => void;
}) {
    const filename = file.path.split("/").pop() ?? file.path;
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={(e) => e.key === "Enter" && onSelect()}
            className={cn(
                "group flex items-center gap-1.5 px-3 py-0.5 cursor-pointer rounded-sm text-sm min-w-0",
                isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50 text-foreground/80"
            )}
        >
            <span className="truncate flex-1 min-w-0 font-mono text-[12px]">
                <span className="font-medium">{filename}</span>
                {dir && <span className="text-muted-foreground ml-1 text-[10px]">{dir}</span>}
            </span>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {!file.staged ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                onClick={(e) => { e.stopPropagation(); onStage(); }}
                            >
                                <Plus className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Stage file</TooltipContent>
                    </Tooltip>
                ) : (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                onClick={(e) => { e.stopPropagation(); onUnstage(); }}
                            >
                                <Minus className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Unstage file</TooltipContent>
                    </Tooltip>
                )}
                {!file.staged && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                                onClick={(e) => { e.stopPropagation(); onDiscard(); }}
                            >
                                <RotateCcw className="h-3 w-3" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>Discard changes</TooltipContent>
                    </Tooltip>
                )}
            </div>
            <FileStatusBadge status={file.status} />
        </div>
    );
}

// ── Branch picker dropdown ────────────────────────────────────────────────────

function BranchPicker() {
    const { branches, currentBranch, checkoutBranch, setShowCreateBranchDialog } = useGitStore();
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");

    const local = branches.filter((b) => !b.is_remote && b.name.toLowerCase().includes(filter.toLowerCase()));

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 font-mono text-xs max-w-[180px]">
                    <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span className="truncate">{currentBranch ?? "no branch"}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <div className="px-2 pb-1">
                    <Input
                        placeholder="Filter branches…"
                        className="h-7 text-xs"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                </div>
                <DropdownMenuSeparator />
                <ScrollArea className="max-h-52">
                    {local.map((b) => (
                        <DropdownMenuItem
                            key={b.name}
                            onClick={() => { checkoutBranch(b.name); setOpen(false); }}
                            className="font-mono text-xs gap-2"
                        >
                            {b.is_current && <Check className="h-3 w-3 text-emerald-400" />}
                            {!b.is_current && <span className="h-3 w-3" />}
                            <span className="truncate">{b.name}</span>
                        </DropdownMenuItem>
                    ))}
                </ScrollArea>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setShowCreateBranchDialog(true); setOpen(false); }}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Create branch…
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ── Create-branch dialog ──────────────────────────────────────────────────────

function CreateBranchDialog() {
    const { showCreateBranchDialog, setShowCreateBranchDialog, currentBranch, createBranch } = useGitStore();
    const [name, setName] = useState("");
    const [from, setFrom] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (showCreateBranchDialog) {
            setName("");
            setFrom(currentBranch ?? "HEAD");
            setError(null);
        }
    }, [showCreateBranchDialog, currentBranch]);

    const handleCreate = async () => {
        if (!name.trim()) { setError("Branch name is required"); return; }
        setLoading(true);
        setError(null);
        try {
            await createBranch(name.trim(), from || "HEAD");
            setShowCreateBranchDialog(false);
        } catch (e: unknown) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={showCreateBranchDialog} onOpenChange={setShowCreateBranchDialog}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <GitBranchIcon className="h-4 w-4 text-emerald-400" /> Create branch
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Branch name</label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="feature/my-branch"
                            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="text-xs text-muted-foreground mb-1 block">From ref</label>
                        <Input
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            placeholder="HEAD or branch name"
                        />
                    </div>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setShowCreateBranchDialog(false)}>Cancel</Button>
                    <Button size="sm" onClick={handleCreate} disabled={loading}>
                        {loading && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Create
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Commit panel ──────────────────────────────────────────────────────────────

function CommitPanel() {
    const {
        commitMessage, setCommitMessage, commit, push, commitAndPush,
        isCommitting, isPushing, remoteInfo, files, author, setShowPrDialog,
        getDiffSummary, setError, stageAll, unstageAll,
    } = useGitStore();
    const getCombo = useShortcutsStore((s) => s.getCombo);
    const [aiGenerateLoading, setAiGenerateLoading] = useState(false);
    const [aiRewriteLoading, setAiRewriteLoading] = useState(false);
    const [actionError, setActionError] = useState<GitActionErrorHelp | null>(null);
    const [showPostPushPrompt, setShowPostPushPrompt] = useState(false);
    const gitAiProvider = useSettingsStore((s) => s.gitAiProvider);
    const stagedCount = files.filter((f) => f.staged).length;
    const unstagedCount = files.length - stagedCount;
    const ahead = remoteInfo?.ahead ?? 0;
    const hasRemote = Boolean(remoteInfo?.remote_url);
    const stageAllShortcut = formatShortcut(getCombo("git_stage_all"));
    const unstageAllShortcut = formatShortcut(getCombo("git_unstage_all"));
    const aiMessageShortcut = formatShortcut(getCombo("git_ai_message"));
    const aiRewriteShortcut = formatShortcut(getCombo("git_ai_rewrite"));
    const commitShortcut = formatShortcut(getCombo("git_commit"));
    const commitPushShortcut = formatShortcut(getCombo("git_commit_push"));
    const openPrShortcut = formatShortcut(getCombo("git_open_pr"));

    const fallbackMessage = `chore: update ${stagedCount} file${stagedCount !== 1 ? "s" : ""}`;

    const showFriendlyActionError = useCallback((error: unknown, action: GitActionKind) => {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(explainGitActionError(message, action));
    }, []);

    const runAiCommit = useCallback(async (rewrite: boolean) => {
        if (stagedCount === 0) {
            setError("Stage changes before using AI commit actions.");
            return;
        }
        if (rewrite && !commitMessage.trim()) {
            setError("Write a draft commit message first, then use AI Rewrite.");
            return;
        }

        if (rewrite) setAiRewriteLoading(true);
        else setAiGenerateLoading(true);
        try {
            const diff = await getDiffSummary();
            if (!diff) {
                setError("No staged changes to generate a message for.");
                return;
            }
            const message = await generateAiCommitMessage({
                diffSummary: diff,
                stagedCount,
                currentMessage: commitMessage,
                rewrite,
            });
            setCommitMessage(message);
            setError(null);
        } catch (e: unknown) {
            if (!rewrite) {
                setCommitMessage(fallbackMessage);
            }
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (rewrite) setAiRewriteLoading(false);
            else setAiGenerateLoading(false);
        }
    }, [stagedCount, setError, commitMessage, getDiffSummary, setCommitMessage, fallbackMessage]);

    const handleCommit = useCallback(async () => {
        const message = commitMessage.trim();
        if (isCommitting) return;
        if (!message) {
            setError("Commit message is required.");
            return;
        }
        if (message.length < 4) {
            setError("Commit message is too short. Add a meaningful summary.");
            return;
        }
        if (stagedCount === 0) {
            setError("No staged files. Stage changes before committing.");
            return;
        }
        try {
            await commit(message);
            setError(null);
        } catch (e: unknown) {
            showFriendlyActionError(e, "commit");
        }
    }, [commitMessage, stagedCount, isCommitting, commit, setError, showFriendlyActionError]);

    const handlePrimaryAction = useCallback(async () => {
        if (isCommitting || isPushing) return;
        const message = commitMessage.trim();

        if (!hasRemote) {
            setError("No remote repository configured. Set origin before pushing.");
            showFriendlyActionError("No remote configured", "push");
            return;
        }

        if (stagedCount > 0 && !message) {
            setError("Commit message is required before Commit & Push.");
            return;
        }

        if (stagedCount > 0 && message.length > 0 && message.length < 4) {
            setError("Commit message is too short. Add a meaningful summary.");
            return;
        }

        if (stagedCount === 0 && ahead <= 0) {
            setError("No local commits to push.");
            return;
        }

        try {
            if (stagedCount > 0 && message) {
                await commitAndPush(message);
                setShowPostPushPrompt(true);
                return;
            }
            if (ahead > 0) {
                await push();
                setShowPostPushPrompt(true);
            }
        } catch (e: unknown) {
            const raw = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
            const commitPhaseError =
                raw.includes("author not configured") ||
                raw.includes("unable to auto-detect email address") ||
                raw.includes("nothing to commit");
            showFriendlyActionError(e, commitPhaseError ? "commit" : "push");
        }
    }, [
        isCommitting,
        isPushing,
        stagedCount,
        commitMessage,
        hasRemote,
        commitAndPush,
        ahead,
        push,
        setError,
        showFriendlyActionError,
    ]);

    const canCommit = Boolean(commitMessage.trim()) && stagedCount > 0 && !isCommitting;
    const canCommitAndPush = canCommit && hasRemote;
    const canPushOnly = stagedCount === 0 && ahead > 0;
    const canPrimaryAction = (canCommitAndPush || canPushOnly) && !isPushing && !isCommitting;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const isTypingTarget = isEditableTarget(e.target);
            const commitCombo = getCombo("git_commit");
            const commitPushCombo = getCombo("git_commit_push");
            const stageAllCombo = getCombo("git_stage_all");
            const unstageAllCombo = getCombo("git_unstage_all");
            const aiMessageCombo = getCombo("git_ai_message");
            const aiRewriteCombo = getCombo("git_ai_rewrite");
            const openPrCombo = getCombo("git_open_pr");

            if (openPrCombo && eventMatchesCombo(e, openPrCombo)) {
                e.preventDefault();
                e.stopPropagation();
                setShowPrDialog(true);
                return;
            }

            if (stageAllCombo && eventMatchesCombo(e, stageAllCombo)) {
                if (isTypingTarget) return;
                e.preventDefault();
                e.stopPropagation();
                if (unstagedCount > 0) void stageAll();
                return;
            }

            if (unstageAllCombo && eventMatchesCombo(e, unstageAllCombo)) {
                if (isTypingTarget) return;
                e.preventDefault();
                e.stopPropagation();
                if (stagedCount > 0) void unstageAll();
                return;
            }

            if (aiMessageCombo && eventMatchesCombo(e, aiMessageCombo)) {
                e.preventDefault();
                e.stopPropagation();
                if (stagedCount > 0) void runAiCommit(false);
                return;
            }

            if (aiRewriteCombo && eventMatchesCombo(e, aiRewriteCombo)) {
                e.preventDefault();
                e.stopPropagation();
                if (stagedCount > 0 && commitMessage.trim()) void runAiCommit(true);
                return;
            }

            if (commitCombo && eventMatchesCombo(e, commitCombo)) {
                e.preventDefault();
                e.stopPropagation();
                if (canCommit) void handleCommit();
                return;
            }

            if (commitPushCombo && eventMatchesCombo(e, commitPushCombo)) {
                e.preventDefault();
                e.stopPropagation();
                if (canPrimaryAction) void handlePrimaryAction();
            }
        };

        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [
        getCombo,
        setShowPrDialog,
        unstageAll,
        stageAll,
        unstagedCount,
        stagedCount,
        commitMessage,
        canCommit,
        canPrimaryAction,
        runAiCommit,
        handleCommit,
        handlePrimaryAction,
    ]);

    return (
        <>
            <div className="p-2 border-t border-border/20 space-y-2.5 bg-background/80 backdrop-blur-sm">
            {!author && (
                <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>Configure your name and email in Git Settings.</span>
                </div>
            )}

            <div className="flex items-center justify-between gap-2 rounded-md border border-border/30 bg-muted/20 px-2 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] tabular-nums">
                        {stagedCount} staged
                    </Badge>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
                        {unstagedCount} changes
                    </Badge>
                </div>
                <div className="flex items-center gap-1">
                    {unstagedCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => { void stageAll(); }}
                            title={stageAllShortcut ? `Stage all (${stageAllShortcut})` : "Stage all"}
                        >
                            Stage all
                        </Button>
                    )}
                    {stagedCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => { void unstageAll(); }}
                            title={unstageAllShortcut ? `Unstage all (${unstageAllShortcut})` : "Unstage all"}
                        >
                            Unstage
                        </Button>
                    )}
                </div>
            </div>

            <Textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Write a commit message (⌘/Ctrl + Enter to commit)"
                className="min-h-[74px] resize-none text-xs font-mono leading-relaxed"
                onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        if (commitMessage.trim() && stagedCount > 0) {
                            void handleCommit();
                        }
                    }
                }}
            />

            <div className="flex items-center gap-1.5">
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => { void runAiCommit(false); }}
                    disabled={aiGenerateLoading || aiRewriteLoading || stagedCount === 0}
                    title={aiMessageShortcut ? `AI Message (${aiMessageShortcut})` : "AI Message"}
                >
                    {aiGenerateLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    AI Message
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => { void runAiCommit(true); }}
                    disabled={aiGenerateLoading || aiRewriteLoading || stagedCount === 0 || !commitMessage.trim()}
                    title={aiRewriteShortcut ? `Rewrite (${aiRewriteShortcut})` : "Rewrite"}
                >
                    {aiRewriteLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Rewrite
                </Button>
                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                    {gitAiProvider === "cloudflare" ? "Cloudflare AI" : "Gemini AI"} · {hasRemote ? `Ahead ${ahead}` : "No remote"}
                </span>
            </div>

            <div className="flex items-center gap-1.5">
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs flex-1"
                    disabled={!canCommit}
                    onClick={() => { void handleCommit(); }}
                    title={commitShortcut ? `Commit (${commitShortcut})` : "Commit"}
                >
                    {isCommitting && <Loader2 className="h-3 w-3 animate-spin" />}
                    <GitCommit className="h-3.5 w-3.5" />
                    Commit
                </Button>

                <Button
                    size="sm"
                    className="h-7 gap-1 text-xs flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-muted disabled:text-muted-foreground"
                    disabled={!canPrimaryAction}
                    onClick={() => { void handlePrimaryAction(); }}
                    title={commitPushShortcut ? `Commit & Push (${commitPushShortcut})` : "Commit & Push"}
                >
                    {isPushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                    {stagedCount > 0 ? "Commit & Push" : "Push"}
                    {ahead > 0 && <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[9px]">{ahead}</Badge>}
                </Button>
            </div>

            <div className="text-[10px] text-muted-foreground/80 flex items-center gap-2 flex-wrap">
                {openPrShortcut && <span>PR {openPrShortcut}</span>}
                {aiMessageShortcut && <span>AI {aiMessageShortcut}</span>}
                {commitShortcut && <span>Commit {commitShortcut}</span>}
                {commitPushShortcut && <span>Push {commitPushShortcut}</span>}
            </div>
            </div>

            <Dialog open={Boolean(actionError)} onOpenChange={(open) => { if (!open) setActionError(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-destructive" />
                            {actionError?.title ?? "Git action failed"}
                        </DialogTitle>
                        <DialogDescription>{actionError?.summary}</DialogDescription>
                    </DialogHeader>
                    {actionError && (
                        <div className="space-y-3">
                            <div>
                                <p className="text-xs font-medium text-foreground/80 mb-1">How to fix</p>
                                <ul className="list-disc pl-4 space-y-1 text-xs text-muted-foreground">
                                    {actionError.fixes.map((fix, idx) => (
                                        <li key={`${fix}-${idx}`}>{fix}</li>
                                    ))}
                                </ul>
                            </div>
                            <div>
                                <p className="text-xs font-medium text-foreground/80 mb-1">Technical details</p>
                                <pre className="text-[11px] rounded-md border border-border/40 bg-muted/30 p-2 whitespace-pre-wrap break-words max-h-28 overflow-auto">
                                    {actionError.technical}
                                </pre>
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button size="sm" onClick={() => setActionError(null)}>
                            Got it
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showPostPushPrompt} onOpenChange={setShowPostPushPrompt}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Check className="h-4 w-4 text-emerald-400" />
                            Push successful
                        </DialogTitle>
                        <DialogDescription>
                            Changes are on GitHub. Do you want to create a Pull Request now?
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setShowPostPushPrompt(false)}>
                            Not now
                        </Button>
                        <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={() => {
                                setShowPostPushPrompt(false);
                                setShowPrDialog(true);
                            }}
                        >
                            <GitPullRequest className="h-3.5 w-3.5" />
                            Create PR
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

// ── Loading workspace (auto for current connection) ───────────────────────────

function LoadingWorkspace() {
    return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
            <p className="text-sm text-muted-foreground">Preparing workspace for this connection…</p>
        </div>
    );
}

// ── Setup / empty state (only when no DB connection) ──────────────────────────

function WorkspaceSetup() {
    const { openWorkspace, savedWorkspaces, loadSavedWorkspaces, isLoading } = useGitStore();

    useEffect(() => { loadSavedWorkspaces(); }, [loadSavedWorkspaces]);

    const handleOpenFolder = async () => {
        const selected = await openDialog({ directory: true, multiple: false });
        if (selected && typeof selected === "string") {
            await openWorkspace(selected);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center h-full gap-6 p-8 text-center">
            <div className="flex flex-col items-center gap-3">
                <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center">
                    <GitBranchIcon className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                    <h2 className="text-sm font-semibold">No workspace open</h2>
                    <p className="text-xs text-muted-foreground mt-1">Connect to a database to auto-create a workspace, or open a folder manually</p>
                </div>
            </div>

            <Button onClick={handleOpenFolder} disabled={isLoading} className="gap-2">
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                Open folder
            </Button>

            {savedWorkspaces.length > 0 && (
                <div className="w-full max-w-sm">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Recent workspaces</p>
                    <div className="space-y-1">
                        {savedWorkspaces.slice(0, 5).map((ws) => (
                            <button
                                key={ws.id}
                                onClick={() => openWorkspace(ws.path)}
                                className="w-full text-left px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            >
                                <div className="truncate font-mono">
                                    {ws.host_name && ws.workspace_name
                                        ? `${ws.host_name} / ${ws.workspace_name}`
                                        : ws.path}
                                </div>
                                <div className="truncate text-[10px] opacity-60 font-mono">
                                    {ws.path}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Git settings dialog ───────────────────────────────────────────────────────

function GitSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { author, setAuthor, remoteInfo, setRemote, workspacePath } = useGitStore();
    const [name, setName] = useState(author?.name ?? "");
    const [email, setEmail] = useState(author?.email ?? "");
    const [remoteUrl, setRemoteUrl] = useState(remoteInfo?.remote_url ?? "");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setName(author?.name ?? "");
            setEmail(author?.email ?? "");
            setRemoteUrl(remoteInfo?.remote_url ?? "");
            setError(null);
        }
    }, [open, author, remoteInfo]);

    const handleSave = async () => {
        if (!name.trim() || !email.trim()) { setError("Name and email are required"); return; }
        setLoading(true);
        try {
            setAuthor({ name: name.trim(), email: email.trim() });
            if (workspacePath) {
                const { gitStorageUpdateAuthor } = await import("@/lib/tauri");
                await gitStorageUpdateAuthor(workspacePath, name.trim(), email.trim());
            }
            if (remoteUrl.trim()) {
                await setRemote(remoteUrl.trim());
            }
            onClose();
        } catch (e: unknown) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Settings className="h-4 w-4" /> Git Settings
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Your name</label>
                            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Your email</label>
                            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Remote URL (origin)</label>
                        <Input
                            value={remoteUrl}
                            onChange={(e) => setRemoteUrl(e.target.value)}
                            placeholder="https://github.com/owner/repo.git"
                            className="font-mono text-xs"
                        />
                    </div>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                    <Button size="sm" onClick={handleSave} disabled={loading}>
                        {loading && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Create GitHub repo dialog ─────────────────────────────────────────────────

type CreateRepoStep = "form" | "creating" | "done";

function CreateRepoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const {
        workspacePath, setRemote, refreshRemoteInfo, refreshStatus,
        githubUser, stageAll, files,
    } = useGitStore();

    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [isPrivate, setIsPrivate] = useState(false);
    const [step, setStep] = useState<CreateRepoStep>("form");
    const [stepMsg, setStepMsg] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState<GithubRepo | null>(null);

    useEffect(() => {
        if (open) {
            const raw = (workspacePath ?? "").split("/").filter(Boolean).pop() ?? "workspace";
            const safe = raw
                .toLowerCase()
                .replace(/[^a-z0-9._-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 100) || "workspace";
            setName(safe);
            setDescription("");
            setIsPrivate(false);
            setStep("form");
            setStepMsg("");
            setError(null);
            setCreated(null);
        }
    }, [open, workspacePath]);

    const handleCreate = async () => {
        if (!name.trim()) { setError("Repository name is required"); return; }
        setStep("creating");
        setError(null);

        try {
            // Step 1 — Ensure the Rust workspace is live (handles cold-start / persisted state)
            setStepMsg("Initialising workspace…");
            if (workspacePath) {
                const { gitSetWorkspace } = await import("@/lib/tauri");
                await gitSetWorkspace(workspacePath);
            }
            
            // Step 2 — Create the GitHub repository
            setStepMsg("Creating repository on GitHub…");
            const repo = await githubCreateRepo(name.trim(), description.trim() || null, isPrivate);

            // Step 3 — Wire the remote into the local git config
            setStepMsg("Setting remote origin…");
            await setRemote(repo.clone_url);
            await refreshRemoteInfo();

            // Step 4 — Stage everything so the user is ready to push immediately
            setStepMsg("Staging all changes…");
            await stageAll();
            await refreshStatus();

            setCreated(repo);
            setStep("done");
        } catch (e: unknown) {
            setError(String(e));
            setStep("form");
        }
    };

    const unstagedCount = files.filter((f) => !f.staged).length;
    const stagedCount   = files.filter((f) => f.staged).length;

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v && step !== "creating") onClose(); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Github className="h-4 w-4" />
                        {step === "done" ? "Published to GitHub" : "Publish to GitHub"}
                    </DialogTitle>
                    {step === "form" && (
                        <DialogDescription>
                            Create a new GitHub repository and connect it to this workspace.
                        </DialogDescription>
                    )}
                </DialogHeader>

                {/* ── Creating progress ─────────────────────────────── */}
                {step === "creating" && (
                    <div className="flex flex-col items-center gap-4 py-6">
                        <div className="h-10 w-10 rounded-full bg-muted/40 flex items-center justify-center">
                            <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                        </div>
                        <p className="text-sm text-muted-foreground">{stepMsg}</p>
                    </div>
                )}

                {/* ── Success ───────────────────────────────────────── */}
                {step === "done" && created && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                            <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-emerald-300 truncate">{created.full_name}</p>
                                <p className="text-xs text-muted-foreground truncate font-mono mt-0.5">{created.clone_url}</p>
                            </div>
                        </div>
                        <div className="rounded-lg border border-border/30 bg-muted/20 divide-y divide-border/20 text-xs">
                            <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-muted-foreground">Remote</span>
                                <span className="font-mono text-foreground/70 truncate max-w-[200px]">origin → {created.clone_url}</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-muted-foreground">Staged files</span>
                                <span className="text-emerald-400 font-medium">{stagedCount} ready to commit</span>
                            </div>
                            {unstagedCount > 0 && (
                                <div className="flex items-center justify-between px-3 py-2">
                                    <span className="text-muted-foreground">Unstaged</span>
                                    <span className="text-amber-400 font-medium">{unstagedCount} files</span>
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            All changes staged. Add a commit message below and hit <strong>Commit &amp; Push</strong>.
                        </p>
                    </div>
                )}

                {/* ── Form ─────────────────────────────────────────── */}
                {step === "form" && (
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Repository name</label>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="my-repo"
                                className="font-mono text-sm"
                                autoFocus
                                onKeyDown={(e) => e.key === "Enter" && !name.trim() === false && handleCreate()}
                            />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">
                                Description <span className="opacity-50">(optional)</span>
                            </label>
                            <Input
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="A short description…"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={() => setIsPrivate((v) => !v)}
                            className="flex items-center gap-3 w-full rounded-md px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                        >
                            <div className={cn(
                                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200",
                                isPrivate ? "bg-emerald-500" : "bg-muted"
                            )}>
                                <span className={cn(
                                    "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200",
                                    isPrivate ? "translate-x-4" : "translate-x-0"
                                )} />
                            </div>
                            <div>
                                <span className="text-sm font-medium">Private repository</span>
                                <p className="text-xs text-muted-foreground">Only you and invited collaborators can access it</p>
                            </div>
                        </button>
                        {githubUser && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <Github className="h-3 w-3" />
                                Creating under{" "}
                                <span className="font-mono text-foreground/70">@{githubUser.login}</span>
                            </p>
                        )}
                        {error && (
                            <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                                <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                                <p className="text-xs text-destructive">{error}</p>
                            </div>
                        )}
                    </div>
                )}

                <DialogFooter>
                    {step === "done" ? (
                        <Button size="sm" onClick={onClose}>Done — ready to push</Button>
                    ) : step === "form" ? (
                        <>
                            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                            <Button
                                size="sm"
                                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                                onClick={handleCreate}
                                disabled={!name.trim()}
                            >
                                <Github className="h-3.5 w-3.5" />
                                Create &amp; publish
                            </Button>
                        </>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function GitPanel() {
    const {
        workspacePath, files, selectedFilePath, selectedFileStaged, activeDiff, isDiffLoading,
        remoteInfo, recentCommits, githubUser,
        isRefreshing, error, setError, isLoading,
        isGithubAuthLoading, isGithubSigningOut,
        openWorkspace, refreshStatus, refreshAll,
        selectFile, stageFile, unstageFile, stageAll, unstageAll, discardFile,
        setShowPrDialog, setShowAuthDialog, checkGithubAuth, signOutGithub, ensureWorkspaceForConnection,
    } = useGitStore();
    const [isSyncingExplorer, setIsSyncingExplorer] = useState(false);
    const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
    const workspaceConnectionId = useGitStore((s) => s.workspaceConnectionId);
    const syncIdeToWorkspace = useGitStore((s) => s.syncIdeToWorkspace);
    const getShortcutCombo = useShortcutsStore((s) => s.getCombo);
    const openPrShortcutLabel = formatShortcut(getShortcutCombo("git_open_pr"));
    const syncConnectionId = workspaceConnectionId ?? activeConnectionId;
    const canSyncExplorer =
        Boolean(workspacePath) &&
        Boolean(syncConnectionId) &&
        (!workspaceConnectionId || workspaceConnectionId === activeConnectionId);
    const ideSyncFingerprint = useIdeFsStore((s) =>
        syncConnectionId ? s.getConnectionSyncFingerprint(syncConnectionId) : ""
    );
    const ideFileCount = useIdeFsStore((s) =>
        syncConnectionId ? s.getFileCount(syncConnectionId) : 0
    );

    const { resolvedTheme } = useTheme();
    const [stagedOpen, setStagedOpen] = useState(true);
    const [changesOpen, setChangesOpen] = useState(true);
    const [commitsOpen, setCommitsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [createRepoOpen, setCreateRepoOpen] = useState(false);
    const isRefreshingRef = useRef(isRefreshing);
    isRefreshingRef.current = isRefreshing;

    // Capture the workspace path at mount time so the effect is stable
    const mountWorkspaceRef = useRef(workspacePath);

    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => !f.staged);

    // Check GitHub auth on mount; also clear stale errors
    useEffect(() => {
        checkGithubAuth();
        setError(null);
    }, [checkGithubAuth, setError]);

    // Re-initialize the Rust GitState on mount. Preserve workspaceConnectionId when restoring
    // so Explorer↔Git sync keeps working after app restart.
    useEffect(() => {
        if (mountWorkspaceRef.current) {
            openWorkspace(mountWorkspaceRef.current, { clearConnectionId: false }).then(() => {
                const connId = useGitStore.getState().workspaceConnectionId;
                if (connId) {
                    useGitStore.getState().syncIdeToWorkspace(connId);
                }
            });
        } else if (activeConnectionId) {
            const databaseName = useConnectionStore.getState().databaseName;
            if (databaseName) {
                useIdeFsStore.getState().ensureConnectionProject(activeConnectionId, databaseName);
            }
            ensureWorkspaceForConnection(activeConnectionId);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // intentionally mount-only

    // Auto-open/switch workspace for active DB connection; ensure IDE tree exists before sync.
    // If the active connection changed (new runtime id), re-bind to that connection's workspace.
    useEffect(() => {
        if (!activeConnectionId) return;

        const databaseName = useConnectionStore.getState().databaseName;
        if (databaseName) {
            useIdeFsStore.getState().ensureConnectionProject(activeConnectionId, databaseName);
        }

        if (!workspacePath) {
            ensureWorkspaceForConnection(activeConnectionId);
            return;
        }

        // Migration path: older persisted state may have a managed workspace path
        // but no workspaceConnectionId. Re-bind so Explorer sync resumes.
        if (!workspaceConnectionId) {
            const isManagedWorkspace =
                workspacePath.includes("/pgstudio/projects/") ||
                workspacePath.includes("\\pgstudio\\projects\\") ||
                workspacePath.includes("/pgstudio/git-workspaces/") ||
                workspacePath.includes("\\pgstudio\\git-workspaces\\");
            if (isManagedWorkspace) {
                ensureWorkspaceForConnection(activeConnectionId);
            }
            return;
        }

        if (workspaceConnectionId && workspaceConnectionId !== activeConnectionId) {
            ensureWorkspaceForConnection(activeConnectionId);
        }
    }, [workspacePath, workspaceConnectionId, activeConnectionId, ensureWorkspaceForConnection]);

    // Live file-change detection — poll while the app is visible.
    useEffect(() => {
        if (!workspacePath) return;
        const id = setInterval(() => {
            if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
            if (!isRefreshingRef.current) refreshStatus();
        }, 2500);
        return () => clearInterval(id);
    }, [workspacePath, refreshStatus]);

    // Ongoing sync: when IDE files for the workspace connection change, debounced sync to disk
    const lastSyncedFingerprint = useRef("");
    const lastSyncScope = useRef("");
    useEffect(() => {
        const scope = `${workspacePath ?? ""}::${syncConnectionId ?? ""}`;
        if (lastSyncScope.current !== scope) {
            lastSyncScope.current = scope;
            lastSyncedFingerprint.current = "";
        }
    }, [workspacePath, syncConnectionId]);

    useEffect(() => {
        if (!workspacePath || !syncConnectionId) return;
        if (workspaceConnectionId && workspaceConnectionId !== activeConnectionId) return;
        if (ideSyncFingerprint === lastSyncedFingerprint.current) return;
        lastSyncedFingerprint.current = ideSyncFingerprint;
        const t = setTimeout(() => {
            void syncIdeToWorkspace(syncConnectionId);
        }, 300);
        return () => clearTimeout(t);
    }, [ideSyncFingerprint, workspacePath, syncConnectionId, workspaceConnectionId, activeConnectionId, syncIdeToWorkspace]);

    const handleRefresh = useCallback(async () => {
        await refreshAll({ fetchRemote: true, refreshAuth: true });
    }, [refreshAll]);

    const handleSyncExplorer = useCallback(async () => {
        if (!syncConnectionId) return;
        if (workspaceConnectionId && workspaceConnectionId !== activeConnectionId) return;
        setIsSyncingExplorer(true);
        try {
            await syncIdeToWorkspace(syncConnectionId);
        } finally {
            setIsSyncingExplorer(false);
        }
    }, [syncConnectionId, workspaceConnectionId, activeConnectionId, syncIdeToWorkspace]);

    if (!workspacePath) {
        if (activeConnectionId && isLoading) return <LoadingWorkspace />;
        return <WorkspaceSetup />;
    }

    const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Toolbar */}
            <div className="flex items-center gap-1.5 px-2 h-9 border-b border-border/20 bg-card/50 shrink-0">
                <BranchPicker />

                <div className="flex-1" />

                {remoteInfo && (remoteInfo.ahead > 0 || remoteInfo.behind > 0) && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        {remoteInfo.ahead > 0 && (
                            <span className="flex items-center gap-0.5 text-emerald-400">
                                <Upload className="h-3 w-3" />{remoteInfo.ahead}
                            </span>
                        )}
                        {remoteInfo.behind > 0 && (
                            <span className="flex items-center gap-0.5 text-amber-400">
                                <Download className="h-3 w-3" />{remoteInfo.behind}
                            </span>
                        )}
                    </div>
                )}

                {canSyncExplorer && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                                onClick={handleSyncExplorer}
                                disabled={isSyncingExplorer}
                            >
                                <FolderSync className={cn("h-3.5 w-3.5", isSyncingExplorer && "animate-pulse")} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Sync Explorer files to Git workspace</TooltipContent>
                    </Tooltip>
                )}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => { void handleRefresh(); }}
                            disabled={isRefreshing}
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Refresh Git status</TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => setShowPrDialog(true)}
                            disabled={!githubUser}
                        >
                            <GitPullRequest className="h-3.5 w-3.5" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        Create Pull Request{openPrShortcutLabel ? ` (${openPrShortcutLabel})` : ""}
                    </TooltipContent>
                </Tooltip>

                {/* Publish to GitHub — visible when no remote is configured */}
                {!remoteInfo?.remote_url && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                                onClick={() => githubUser ? setCreateRepoOpen(true) : setShowAuthDialog(true)}
                            >
                                <CloudUpload className="h-3.5 w-3.5" />
                                Publish
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {githubUser ? "Create a GitHub repository for this workspace" : "Connect GitHub to publish"}
                        </TooltipContent>
                    </Tooltip>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn("h-7 w-7", githubUser ? "text-emerald-400" : "text-muted-foreground")}
                            title={githubUser ? `GitHub: ${githubUser.login}` : "Connect to GitHub"}
                        >
                            {isGithubAuthLoading || isGithubSigningOut
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Github className="h-3.5 w-3.5" />}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel className="px-2 py-1.5">
                            <div className="text-xs font-medium">GitHub account</div>
                            <div className="text-[10px] text-muted-foreground">
                                {githubUser ? `Signed in as @${githubUser.login}` : "Not connected"}
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {githubUser ? (
                            <>
                                <DropdownMenuItem
                                    className="gap-2 text-xs"
                                    onClick={() => setShowAuthDialog(true)}
                                >
                                    <Github className="h-3.5 w-3.5" />
                                    Manage connection
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="gap-2 text-xs"
                                    onClick={() => { void checkGithubAuth(); }}
                                    disabled={isGithubAuthLoading || isGithubSigningOut}
                                >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    Refetch GitHub session
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="gap-2 text-xs"
                                    onClick={() => { void handleRefresh(); }}
                                    disabled={isRefreshing}
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    Refetch Git data
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    variant="destructive"
                                    className="gap-2 text-xs"
                                    disabled={isGithubSigningOut}
                                    onClick={() => {
                                        void signOutGithub().catch((e: unknown) => setError(String(e)));
                                    }}
                                >
                                    {isGithubSigningOut
                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        : <LogOut className="h-3.5 w-3.5" />}
                                    Sign out from GitHub
                                </DropdownMenuItem>
                            </>
                        ) : (
                            <>
                                <DropdownMenuItem
                                    className="gap-2 text-xs"
                                    onClick={() => setShowAuthDialog(true)}
                                >
                                    <Github className="h-3.5 w-3.5" />
                                    Connect GitHub
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="gap-2 text-xs"
                                    onClick={() => { void handleRefresh(); }}
                                    disabled={isRefreshing}
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    Refresh Git panel
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSettingsOpen(true)}>
                            <Settings className="h-3.5 w-3.5" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Git settings</TooltipContent>
                </Tooltip>
            </div>

            {/* Error banner */}
            {error && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive shrink-0">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate">{error}</span>
                    <button onClick={() => setError(null)}>
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {/* No-remote banner */}
            {!remoteInfo?.remote_url && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-sky-500/5 border-b border-sky-500/15 text-xs text-sky-400/80 shrink-0">
                    <CloudUpload className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">No remote configured.</span>
                    <button
                        className="font-medium text-sky-400 hover:text-sky-300 transition-colors"
                        onClick={() => githubUser ? setCreateRepoOpen(true) : setShowAuthDialog(true)}
                    >
                        {githubUser ? "Publish to GitHub →" : "Connect GitHub →"}
                    </button>
                </div>
            )}

            {/* Main split: file list | diff viewer */}
            <div className="flex flex-1 min-h-0">
                {/* Left: file list + commit */}
                <div className="flex flex-col w-[320px] min-w-[240px] max-w-[380px] border-r border-border/20 shrink-0">
                    <ScrollArea className="flex-1 min-h-0">
                        <div className="py-1.5 space-y-1">
                            <div className="px-2">
                                <div className="rounded-md border border-border/30 bg-muted/20 px-2 py-1.5 space-y-1.5">
                                    {canSyncExplorer && (
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[10px] text-emerald-500/90 font-medium flex items-center gap-1">
                                                <FolderSync className="h-3 w-3 shrink-0" />
                                                Explorer synced
                                            </span>
                                            <span className="text-[10px] text-muted-foreground tabular-nums">
                                                {ideFileCount} files
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex items-center gap-1.5">
                                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] tabular-nums">
                                            Staged {staged.length}
                                        </Badge>
                                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
                                            Changes {unstaged.length}
                                        </Badge>
                                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] tabular-nums ml-auto">
                                            Total {files.length}
                                        </Badge>
                                    </div>
                                </div>
                            </div>

                            {/* STAGED section */}
                            <div>
                                <div className="flex items-center gap-1 px-2">
                                    <button
                                        className="flex items-center gap-1 flex-1 px-0 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground text-left"
                                        onClick={() => setStagedOpen((v) => !v)}
                                    >
                                        {stagedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        Staged ({staged.length})
                                    </button>
                                    {staged.length > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5"
                                            title="Unstage all"
                                            onClick={() => { void unstageAll(); }}
                                        >
                                            <Minus className="h-3 w-3" />
                                        </Button>
                                    )}
                                </div>
                                {stagedOpen && staged.length === 0 && (
                                    <p className="px-3 py-1 text-[11px] text-muted-foreground">No staged files</p>
                                )}
                                {stagedOpen && staged.map((f) => (
                                    <FileRow
                                        key={`staged-${f.path}`}
                                        file={f}
                                        isSelected={selectedFilePath === f.path && selectedFileStaged}
                                        onSelect={() => selectFile(f.path, true)}
                                        onStage={() => stageFile(f.path)}
                                        onUnstage={() => unstageFile(f.path)}
                                        onDiscard={() => discardFile(f.path)}
                                    />
                                ))}
                            </div>

                            {/* CHANGES section */}
                            <div className="mt-1">
                                <div className="flex items-center gap-1 px-2">
                                    <button
                                        className="flex items-center gap-1 flex-1 px-0 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground text-left"
                                        onClick={() => setChangesOpen((v) => !v)}
                                    >
                                        {changesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        Changes ({unstaged.length})
                                    </button>
                                    {unstaged.length > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5"
                                            title="Stage all"
                                            onClick={() => { void stageAll(); }}
                                        >
                                            <Plus className="h-3 w-3" />
                                        </Button>
                                    )}
                                </div>
                                {changesOpen && unstaged.length === 0 && (
                                    <p className="px-3 py-1 text-[11px] text-muted-foreground">Working tree clean</p>
                                )}
                                {changesOpen && unstaged.map((f) => (
                                    <FileRow
                                        key={`unstaged-${f.path}`}
                                        file={f}
                                        isSelected={selectedFilePath === f.path && !selectedFileStaged}
                                        onSelect={() => selectFile(f.path, false)}
                                        onStage={() => stageFile(f.path)}
                                        onUnstage={() => unstageFile(f.path)}
                                        onDiscard={() => discardFile(f.path)}
                                    />
                                ))}
                            </div>

                            {/* COMMITS section */}
                            <div className="mt-1">
                                <button
                                    className="flex items-center gap-1 w-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                                    onClick={() => setCommitsOpen((v) => !v)}
                                >
                                    {commitsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                    Recent commits
                                </button>
                                {commitsOpen && recentCommits.length === 0 && (
                                    <p className="px-3 py-1 text-[11px] text-muted-foreground">No commits yet</p>
                                )}
                                {commitsOpen && recentCommits.map((c) => (
                                    <div key={c.hash} className="px-3 py-1 text-[11px] hover:bg-muted/40 rounded-sm cursor-default">
                                        <div className="flex items-center gap-1.5">
                                            <span className="font-mono text-[10px] text-muted-foreground shrink-0">{c.short_hash}</span>
                                            <span className="truncate text-foreground/80">{c.message}</span>
                                        </div>
                                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">{c.author_name} · {new Date(c.date).toLocaleDateString()}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </ScrollArea>

                    {/* Commit panel */}
                    <CommitPanel />
                </div>

                {/* Right: diff viewer */}
                <div className="flex-1 min-w-0 flex flex-col">
                    {selectedFilePath && (
                        <div className="flex items-center gap-2 px-3 h-7 border-b border-border/20 bg-card/50 text-xs text-muted-foreground shrink-0">
                            <span className="font-mono truncate">{selectedFilePath}</span>
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                                {selectedFileStaged ? "staged" : "working tree"}
                            </Badge>
                        </div>
                    )}

                    {isDiffLoading ? (
                        <div className="flex-1 flex items-center justify-center">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : activeDiff ? (
                        activeDiff.is_binary ? (
                            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                                Binary file — no diff available
                            </div>
                        ) : (
                            <div className="flex-1">
                                <DiffEditor
                                    height="100%"
                                    language="sql"
                                    original={activeDiff.old_content}
                                    modified={activeDiff.new_content}
                                    theme={monacoTheme}
                                    options={{
                                        readOnly: true,
                                        renderSideBySide: true,
                                        minimap: { enabled: false },
                                        scrollBeyondLastLine: false,
                                        fontSize: 12,
                                        lineNumbers: "on",
                                        wordWrap: "on",
                                        padding: { top: 8 },
                                        diffAlgorithm: "advanced",
                                    }}
                                />
                            </div>
                        )
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
                            <div className="h-10 w-10 rounded-lg bg-muted/40 flex items-center justify-center">
                                <GitCommit className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-foreground/70">Select a file to view diff</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {files.length === 0
                                        ? "No changes to commit — stage and commit to save your work."
                                        : `${files.length} file${files.length !== 1 ? "s" : ""} changed`}
                                </p>
                            </div>
                            {files.length > 0 && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => {
                                        const first = unstaged[0] ?? staged[0];
                                        if (first) {
                                            void selectFile(first.path, first.staged);
                                        }
                                    }}
                                >
                                    Open first change
                                </Button>
                            )}
                            {files.length === 0 && remoteInfo?.remote_url && (
                                <p className="text-xs text-muted-foreground">
                                    Remote: <span className="font-mono text-foreground/60">{remoteInfo.remote_url}</span>
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Dialogs */}
            <CreateBranchDialog />
            <GithubAuthDialog />
            <CreatePrDialog />
            <GitSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            <CreateRepoDialog open={createRepoOpen} onClose={() => setCreateRepoOpen(false)} />
        </div>
    );
}
