"use client";

import { useEffect, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useGitStore } from "@/stores/git-store";
import {
    githubCreatePr,
    githubListCollaborators,
    githubListRemoteBranches,
    githubCreateRepo,
    openPath,
    type GithubCollaborator,
    type GithubBranch,
    type GithubPullRequest,
} from "@/lib/tauri";
import { generateAiPullRequestDraft } from "@/lib/git-ai";
import { useSettingsStore } from "@/stores/settings-store";
import {
    AlertCircle,
    Check,
    ExternalLink,
    GitPullRequest,
    Github,
    Loader2,
    Sparkles,
    Lock,
    Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Reviewer picker ───────────────────────────────────────────────────────────

function ReviewerPicker({
    owner,
    repo,
    selected,
    onToggle,
}: {
    owner: string;
    repo: string;
    selected: string[];
    onToggle: (login: string) => void;
}) {
    const [collaborators, setCollaborators] = useState<GithubCollaborator[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        githubListCollaborators(owner, repo)
            .then((items) => {
                if (!cancelled) setCollaborators(items);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [owner, repo]);

    if (loading) {
        return <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading collaborators…</div>;
    }

    if (collaborators.length === 0) {
        return <p className="text-xs text-muted-foreground">No collaborators found.</p>;
    }

    return (
        <div className="flex flex-wrap gap-1.5">
            {collaborators.map((c) => {
                const isSelected = selected.includes(c.login);
                return (
                    <button
                        key={c.login}
                        type="button"
                        onClick={() => onToggle(c.login)}
                        className={cn(
                            "flex items-center gap-1.5 px-2 py-1 rounded-full text-xs border transition-colors",
                            isSelected
                                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                                : "bg-muted/40 border-border hover:border-muted-foreground text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Avatar className="h-4 w-4">
                            <AvatarImage src={c.avatar_url} alt={c.login} />
                            <AvatarFallback className="text-[7px]">{c.login[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                        {c.login}
                        {isSelected && <Check className="h-3 w-3" />}
                    </button>
                );
            })}
        </div>
    );
}

// ── Create-repo sub-form ──────────────────────────────────────────────────────

function CreateRepoForm({ onCreated }: { onCreated: (cloneUrl: string) => void }) {
    const { githubUser } = useGitStore();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [isPrivate, setIsPrivate] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCreate = async () => {
        if (!name.trim()) { setError("Repository name is required"); return; }
        setLoading(true);
        setError(null);
        try {
            const repo = await githubCreateRepo(name.trim(), description.trim() || null, isPrivate);
            onCreated(repo.clone_url);
        } catch (e: unknown) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-3 p-3 bg-muted/20 rounded-lg border border-border/40">
            <p className="text-xs font-medium text-foreground/70">Create a new repository on GitHub</p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{githubUser?.login ?? "you"} /</span>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-repo-name"
                    className="h-7 text-xs font-mono flex-1"
                />
            </div>
            <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                className="h-7 text-xs"
            />
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => setIsPrivate(false)}
                    className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition-colors",
                        !isPrivate ? "bg-sky-500/15 border-sky-500/40 text-sky-300" : "border-border text-muted-foreground hover:text-foreground"
                    )}
                >
                    <Globe className="h-3 w-3" /> Public
                </button>
                <button
                    type="button"
                    onClick={() => setIsPrivate(true)}
                    className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition-colors",
                        isPrivate ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "border-border text-muted-foreground hover:text-foreground"
                    )}
                >
                    <Lock className="h-3 w-3" /> Private
                </button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button size="sm" className="h-7 text-xs w-full gap-1.5" onClick={handleCreate} disabled={loading}>
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}
                Create repository
            </Button>
        </div>
    );
}

// ── Main dialog ───────────────────────────────────────────────────────────────

export function CreatePrDialog() {
    const {
        showPrDialog, setShowPrDialog,
        remoteInfo, currentBranch, recentCommits,
        githubToken, getDiffSummary, setRemote, setShowAuthDialog, checkGithubAuth,
    } = useGitStore();
    const gitAiProvider = useSettingsStore((s) => s.gitAiProvider);

    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [baseBranch, setBaseBranch] = useState("main");
    const [remoteBranches, setRemoteBranches] = useState<GithubBranch[]>([]);
    const [reviewers, setReviewers] = useState<string[]>([]);
    const [aiLoading, setAiLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdPr, setCreatedPr] = useState<GithubPullRequest | null>(null);
    const [needsRepo, setNeedsRepo] = useState(false);

    const owner = remoteInfo?.owner ?? null;
    const repoName = remoteInfo?.repo ?? null;
    const headBranch = currentBranch ?? "main";
    const hasGithubSession = Boolean(githubToken);

    useEffect(() => {
        if (!showPrDialog) return;
        setTitle("");
        setBody("");
        setCreatedPr(null);
        setError(null);
        setReviewers([]);
        setNeedsRepo(!remoteInfo?.remote_url);
        void checkGithubAuth({ silent: true });

        // Pre-fill title from latest commit
        if (recentCommits.length > 0) {
            setTitle(recentCommits[0].message);
        }

        // Load remote branches
        if (owner && repoName) {
            githubListRemoteBranches(owner, repoName)
                .then((branches) => {
                    setRemoteBranches(branches);
                    const defaultBranch = branches.find((b) => b.name === "main" || b.name === "master");
                    if (defaultBranch) setBaseBranch(defaultBranch.name);
                })
                .catch(() => {});
        }
    }, [showPrDialog, owner, repoName, recentCommits, remoteInfo, checkGithubAuth]);

    const handleAIGenerate = async () => {
        setAiLoading(true);
        setError(null);
        try {
            const diff = await getDiffSummary();
            const draft = await generateAiPullRequestDraft({
                diffSummary: diff,
                headBranch,
                baseBranch,
                commitMessages: recentCommits
                    .slice(0, 20)
                    .map((c) => `${c.short_hash} ${c.message}`),
            });
            setTitle(draft.title);
            setBody(draft.body);
        } catch (e: unknown) {
            if (!title.trim()) {
                setTitle(recentCommits[0]?.message ?? `Merge ${headBranch} into ${baseBranch}`);
            }
            if (!body.trim()) {
                const lines = recentCommits.slice(0, 6).map((c) => `- ${c.message} (${c.short_hash})`);
                setBody(
                    `## Summary\n- Prepare ${headBranch} for merge into ${baseBranch}\n\n## Changes\n${lines.join("\n") || "- Updated project files"}\n\n## Testing\n- Not run (local changes only)`
                );
            }
            setError(e instanceof Error ? e.message : "Failed to generate AI pull request content.");
        } finally {
            setAiLoading(false);
        }
    };

    const handleSubmit = async () => {
        if (!owner || !repoName) { setError("No remote repository configured."); return; }
        if (!title.trim()) { setError("Title is required"); return; }
        setLoading(true);
        setError(null);
        try {
            const pr = await githubCreatePr(
                owner,
                repoName,
                title.trim(),
                body.trim() || null,
                headBranch,
                baseBranch,
                reviewers,
            );
            setCreatedPr(pr);
        } catch (e: unknown) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    const toggleReviewer = (login: string) => {
        setReviewers((prev) =>
            prev.includes(login) ? prev.filter((r) => r !== login) : [...prev, login]
        );
    };

    const handleRepoCreated = async (cloneUrl: string) => {
        await setRemote(cloneUrl);
        setNeedsRepo(false);
        setRemoteBranches([]);
    };

    return (
        <Dialog open={showPrDialog} onOpenChange={setShowPrDialog}>
            <DialogContent className="sm:max-w-3xl max-h-[calc(100vh-2.5rem)] p-0 overflow-hidden flex flex-col">
                <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/20 shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <GitPullRequest className="h-4 w-4 text-violet-400" />
                        Create Pull Request
                    </DialogTitle>
                </DialogHeader>

                {createdPr ? (
                    /* Success state */
                    <div className="flex flex-col items-center gap-4 py-6">
                        <div className="h-14 w-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                            <Check className="h-7 w-7 text-emerald-400" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold">Pull request created!</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                #{createdPr.number} — {createdPr.title}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                onClick={() => {
                                    openPath(createdPr.html_url).catch(() => {
                                        if (typeof window !== "undefined") {
                                            window.open(createdPr.html_url, "_blank");
                                        }
                                    });
                                }}
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open on GitHub
                            </Button>
                            <Button size="sm" onClick={() => setShowPrDialog(false)}>Done</Button>
                        </div>
                    </div>
                ) : (
                    <ScrollArea className="flex-1 min-h-0">
                        <div className="space-y-4 px-5 py-4 pb-6">
                            {!hasGithubSession && (
                                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    <span className="flex-1">Connect to GitHub first to create pull requests.</span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs"
                                        onClick={() => setShowAuthDialog(true)}
                                    >
                                        Connect
                                    </Button>
                                </div>
                            )}

                            {needsRepo && (
                                <CreateRepoForm onCreated={handleRepoCreated} />
                            )}

                            {!needsRepo && (
                                <>
                                    <div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-2">
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                                            <Badge variant="secondary" className="font-mono text-[11px]">{headBranch}</Badge>
                                            <span>→</span>
                                            {remoteBranches.length > 0 ? (
                                                <Select value={baseBranch} onValueChange={setBaseBranch}>
                                                    <SelectTrigger className="h-7 text-xs w-40 font-mono">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {remoteBranches.map((b) => (
                                                            <SelectItem key={b.name} value={b.name} className="font-mono text-xs">
                                                                {b.name}{b.protected && " 🔒"}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            ) : (
                                                <Input
                                                    value={baseBranch}
                                                    onChange={(e) => setBaseBranch(e.target.value)}
                                                    className="h-7 text-xs w-40 font-mono"
                                                    placeholder="main"
                                                />
                                            )}
                                            {owner && repoName && (
                                                <Badge variant="outline" className="ml-auto font-mono text-[10px] max-w-full">
                                                    {owner}/{repoName}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                            <span>Head: {headBranch}</span>
                                            <span>Commits available: {recentCommits.length}</span>
                                        </div>
                                    </div>

                                    <div className="rounded-lg border border-border/30 bg-card/20 p-3 space-y-3">
                                        <div className="flex items-center justify-between mb-1">
                                            <label className="text-xs text-muted-foreground">Title</label>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                                                onClick={handleAIGenerate}
                                                disabled={aiLoading}
                                            >
                                                {aiLoading
                                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                                    : <Sparkles className="h-3 w-3" />}
                                                AI Draft
                                            </Button>
                                        </div>
                                        <Input
                                            value={title}
                                            onChange={(e) => setTitle(e.target.value)}
                                            placeholder="PR title…"
                                        />
                                        <p className="text-[10px] text-muted-foreground">
                                            {gitAiProvider === "cloudflare" ? "Cloudflare AI" : "Gemini AI"} draft uses your branch diff and recent commit history.
                                        </p>
                                        <label className="text-xs text-muted-foreground mb-1 block">Description</label>
                                        <Textarea
                                            value={body}
                                            onChange={(e) => setBody(e.target.value)}
                                            placeholder="Describe what changed and why…&#10;&#10;Supports Markdown."
                                            className="min-h-[180px] resize-y text-xs font-mono leading-relaxed"
                                        />
                                    </div>

                                    {/* Reviewers */}
                                    {owner && repoName && (
                                        <div className="rounded-lg border border-border/30 bg-muted/15 p-3">
                                            <label className="text-xs text-muted-foreground mb-1.5 block">
                                                Reviewers {reviewers.length > 0 && `(${reviewers.length})`}
                                            </label>
                                            <ReviewerPicker
                                                key={`${owner}/${repoName}`}
                                                owner={owner}
                                                repo={repoName}
                                                selected={reviewers}
                                                onToggle={toggleReviewer}
                                            />
                                        </div>
                                    )}

                                    {/* Recent commits preview */}
                                    {recentCommits.length > 0 && (
                                        <div className="rounded-lg border border-border/30 bg-muted/15 p-3">
                                            <label className="text-xs text-muted-foreground mb-1 block">
                                                Commits ({recentCommits.length})
                                            </label>
                                            <div className="space-y-1 max-h-28 overflow-y-auto">
                                                {recentCommits.slice(0, 8).map((c) => (
                                                    <div key={c.hash} className="flex items-center gap-2 text-[11px]">
                                                        <span className="font-mono text-muted-foreground shrink-0">{c.short_hash}</span>
                                                        <span className="truncate text-foreground/70">{c.message}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {error && (
                                        <div className="flex items-center gap-2 p-2 rounded bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                            {error}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </ScrollArea>
                )}

                {!createdPr && (
                    <DialogFooter className="shrink-0 border-t border-border/20 bg-background/95 supports-[backdrop-filter]:bg-background/80 backdrop-blur px-5 py-3">
                        <Button variant="outline" size="sm" onClick={() => setShowPrDialog(false)}>Cancel</Button>
                        {!needsRepo && (
                            <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={handleSubmit}
                                disabled={loading || !hasGithubSession || !owner || !repoName || !title.trim()}
                            >
                                {loading
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <GitPullRequest className="h-3.5 w-3.5" />}
                                Create Pull Request
                            </Button>
                        )}
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}
