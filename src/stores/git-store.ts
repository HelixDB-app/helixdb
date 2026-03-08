import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
    GitFileStatus,
    GitBranch,
    GitCommit,
    GitRemoteInfo,
    GithubUser,
    WorkspaceInfo,
} from "@/lib/tauri";
import {
    gitOpenWorkspace,
    gitEnsureWorkspaceForConnection,
    gitGetStatus,
    syncIdeFilesToWorkspace,
    gitGetDiff,
    gitStageFiles,
    gitStageAll,
    gitUnstageFiles,
    gitCommit,
    gitPush,
    gitFetchRemote,
    gitListBranches,
    gitCreateBranch,
    gitCheckoutBranch,
    gitDeleteBranch,
    gitGetLog,
    gitGetRemoteInfo,
    gitGetDiffSummary,
    gitDiscardChanges,
    gitSetRemote,
    gitStorageListWorkspaces,
    gitStorageDeleteWorkspace,
    gitStorageUpdateRemote,
    githubGetCurrentUser,
    githubRevokeToken,
    githubGetToken,
    type GitDiff,
    type GitWorkspace,
} from "@/lib/tauri";
import { deriveGitProjectIdentity } from "@/lib/git-project";
import { useIdeFsStore } from "@/stores/ide-fs-store";
import { useConnectionStore } from "@/stores/connection-store";

// ── Types ─────────────────────────────────────────────────────────────────────

export type { GitFileStatus, GitBranch, GitCommit, GitRemoteInfo, GithubUser };

export interface GitAuthor {
    name: string;
    email: string;
}

interface GitState {
    // workspace
    workspacePath: string | null;
    workspaceInfo: WorkspaceInfo | null;
    /** When set, workspace was created for this connection; sync IDE files for this connection only. */
    workspaceConnectionId: string | null;
    savedWorkspaces: GitWorkspace[];

    // file status
    files: GitFileStatus[];
    selectedFilePath: string | null;
    selectedFileStaged: boolean;
    activeDiff: GitDiff | null;
    isDiffLoading: boolean;

    // branches
    branches: GitBranch[];
    currentBranch: string | null;

    // commits
    recentCommits: GitCommit[];

    // remote
    remoteInfo: GitRemoteInfo | null;

    // github auth
    githubUser: GithubUser | null;
    githubToken: string | null;

    // author config
    author: GitAuthor | null;

    // loading / error
    isLoading: boolean;
    isRefreshing: boolean;
    isPushing: boolean;
    isCommitting: boolean;
    isGithubAuthLoading: boolean;
    isGithubSigningOut: boolean;
    error: string | null;

    // ui state (not persisted)
    commitMessage: string;
    showCreateBranchDialog: boolean;
    showPrDialog: boolean;
    showAuthDialog: boolean;
}

interface GitActions {
    // workspace
    openWorkspace: (path: string, options?: { clearConnectionId?: boolean }) => Promise<void>;
    ensureWorkspaceForConnection: (connectionId: string) => Promise<void>;
    /** Sync IDE file tree to workspace disk and refresh status. No-op if workspace not for this connection. */
    syncIdeToWorkspace: (connectionId: string) => Promise<void>;
    loadSavedWorkspaces: () => Promise<void>;
    removeWorkspace: (path: string) => Promise<void>;
    setWorkspacePath: (path: string | null) => void;

    // status & diff
    refreshStatus: () => Promise<void>;
    refreshAll: (options?: { fetchRemote?: boolean; refreshAuth?: boolean }) => Promise<void>;
    selectFile: (path: string, staged: boolean) => Promise<void>;
    clearDiff: () => void;

    // staging
    stageFile: (path: string) => Promise<void>;
    unstageFile: (path: string) => Promise<void>;
    stageAll: () => Promise<void>;
    unstageAll: () => Promise<void>;
    discardFile: (path: string) => Promise<void>;

    // commit
    setCommitMessage: (msg: string) => void;
    commit: (message: string) => Promise<GitCommit>;
    commitAndPush: (message: string) => Promise<void>;

    // push/pull
    push: () => Promise<void>;

    // branches
    refreshBranches: () => Promise<void>;
    createBranch: (name: string, from: string) => Promise<void>;
    checkoutBranch: (name: string) => Promise<void>;
    deleteBranch: (name: string) => Promise<void>;

    // remote
    refreshRemoteInfo: (options?: { fetch?: boolean }) => Promise<void>;
    setRemote: (url: string) => Promise<void>;

    // commits log
    refreshLog: (limit?: number) => Promise<void>;

    // github
    setGithubUser: (user: GithubUser | null) => void;
    signOutGithub: () => Promise<void>;
    checkGithubAuth: (options?: { silent?: boolean }) => Promise<void>;

    // author
    setAuthor: (author: GitAuthor) => void;

    // ui
    setShowCreateBranchDialog: (v: boolean) => void;
    setShowPrDialog: (v: boolean) => void;
    setShowAuthDialog: (v: boolean) => void;
    setError: (err: string | null) => void;

    // diff summary for AI
    getDiffSummary: () => Promise<string>;
}

type GitStore = GitState & GitActions;

// ── Store ─────────────────────────────────────────────────────────────────────

export const useGitStore = create<GitStore>()(
    persist(
        (set, get) => ({
            // initial state
            workspacePath: null,
            workspaceInfo: null,
            workspaceConnectionId: null,
            savedWorkspaces: [],
            files: [],
            selectedFilePath: null,
            selectedFileStaged: false,
            activeDiff: null,
            isDiffLoading: false,
            branches: [],
            currentBranch: null,
            recentCommits: [],
            remoteInfo: null,
            githubUser: null,
            githubToken: null,
            author: null,
            isLoading: false,
            isRefreshing: false,
            isPushing: false,
            isCommitting: false,
            isGithubAuthLoading: false,
            isGithubSigningOut: false,
            error: null,
            commitMessage: "",
            showCreateBranchDialog: false,
            showPrDialog: false,
            showAuthDialog: false,

            // ── Workspace ────────────────────────────────────────────────────

            openWorkspace: async (path, options) => {
                const clearConnectionId = options?.clearConnectionId !== false;
                set({ isLoading: true, error: null, ...(clearConnectionId && { workspaceConnectionId: null }) });
                try {
                    const info = await gitOpenWorkspace(path);
                    set({
                        workspacePath: info.path,
                        workspaceInfo: info,
                        ...(clearConnectionId && { workspaceConnectionId: null }),
                        currentBranch: info.current_branch,
                    });
                    await get().refreshAll({ fetchRemote: true, refreshAuth: true });
                } catch (e: unknown) {
                    const msg = String(e);
                    if (msg.includes("not found") || msg.includes("No such file")) {
                        set({ workspacePath: null, workspaceInfo: null, workspaceConnectionId: null, error: null });
                    } else {
                        set({ error: msg });
                    }
                } finally {
                    set({ isLoading: false });
                }
            },

            ensureWorkspaceForConnection: async (connectionId) => {
                set({ isLoading: true, error: null });
                try {
                    const connectionState = useConnectionStore.getState();
                    const connectionEntry = connectionState.connections.find(
                        (entry) => entry.connectionId === connectionId
                    );
                    const projectIdentity = deriveGitProjectIdentity(
                        connectionId,
                        connectionEntry?.connectionString ?? connectionState.connectionString,
                        connectionEntry?.databaseName ?? connectionState.databaseName
                    );
                    const info = await gitEnsureWorkspaceForConnection(connectionId, projectIdentity);
                    set({
                        workspacePath: info.path,
                        workspaceInfo: info,
                        workspaceConnectionId: connectionId,
                        currentBranch: info.current_branch,
                    });
                    await get().syncIdeToWorkspace(connectionId);
                    await get().refreshAll({ fetchRemote: true, refreshAuth: true });
                } catch (e: unknown) {
                    set({ error: String(e) });
                } finally {
                    set({ isLoading: false });
                }
            },

            syncIdeToWorkspace: async (connectionId) => {
                const { workspacePath, workspaceConnectionId } = get();
                if (!workspacePath) return;
                if (workspaceConnectionId && workspaceConnectionId !== connectionId) return;
                const entries = useIdeFsStore.getState().getAllFileEntries(connectionId);
                await syncIdeFilesToWorkspace(workspacePath, entries);
                await get().refreshStatus();
            },

            loadSavedWorkspaces: async () => {
                try {
                    const workspaces = await gitStorageListWorkspaces();
                    set({ savedWorkspaces: workspaces });
                } catch {
                    // non-critical
                }
            },

            removeWorkspace: async (path) => {
                await gitStorageDeleteWorkspace(path);
                const workspaces = await gitStorageListWorkspaces();
                set({ savedWorkspaces: workspaces });
                if (get().workspacePath === path) {
                    set({ workspacePath: null, workspaceInfo: null, files: [], branches: [] });
                }
            },

            setWorkspacePath: (path) => set({ workspacePath: path }),

            // ── Status & diff ────────────────────────────────────────────────

            refreshStatus: async () => {
                if (!get().workspacePath) return;
                set({ isRefreshing: true });
                try {
                    const files = await gitGetStatus();
                    set({ files, error: null });
                } catch (e: unknown) {
                    const msg = String(e);
                    // Suppress "no workspace" errors — they're expected before a folder is opened
                    if (!msg.includes("No workspace open")) {
                        set({ error: msg });
                    }
                } finally {
                    set({ isRefreshing: false });
                }
            },

            refreshAll: async (options) => {
                const { workspacePath } = get();
                const fetchRemote = options?.fetchRemote ?? false;
                const refreshAuth = options?.refreshAuth ?? false;
                const tasks: Promise<unknown>[] = [];
                if (workspacePath) {
                    tasks.push(
                        get().refreshStatus(),
                        get().refreshBranches(),
                        get().refreshRemoteInfo({ fetch: fetchRemote }),
                        get().refreshLog()
                    );
                }
                if (refreshAuth) {
                    tasks.push(get().checkGithubAuth({ silent: true }));
                }
                await Promise.all(tasks);
            },

            selectFile: async (path, staged) => {
                set({ selectedFilePath: path, selectedFileStaged: staged, isDiffLoading: true, activeDiff: null });
                try {
                    const diff = await gitGetDiff(path, staged);
                    set({ activeDiff: diff });
                } catch (e: unknown) {
                    set({ error: String(e), activeDiff: null });
                } finally {
                    set({ isDiffLoading: false });
                }
            },

            clearDiff: () => set({ activeDiff: null, selectedFilePath: null }),

            // ── Staging ──────────────────────────────────────────────────────

            stageFile: async (path) => {
                await gitStageFiles([path]);
                await get().refreshStatus();
            },

            unstageFile: async (path) => {
                await gitUnstageFiles([path]);
                await get().refreshStatus();
            },

            stageAll: async () => {
                await gitStageAll();
                await get().refreshStatus();
            },

            unstageAll: async () => {
                const staged = get().files.filter((f) => f.staged).map((f) => f.path);
                if (staged.length > 0) {
                    await gitUnstageFiles(staged);
                    await get().refreshStatus();
                }
            },

            discardFile: async (path) => {
                await gitDiscardChanges(path);
                await get().refreshStatus();
                if (get().selectedFilePath === path) {
                    set({ activeDiff: null, selectedFilePath: null });
                }
            },

            // ── Commit ───────────────────────────────────────────────────────

            setCommitMessage: (msg) => set({ commitMessage: msg }),

            commit: async (message) => {
                const { author } = get();
                if (!author) throw new Error("Git author not configured. Set your name and email.");
                set({ isCommitting: true, error: null });
                try {
                    const result = await gitCommit(message, author.name, author.email);
                    set({ commitMessage: "", recentCommits: [result, ...get().recentCommits].slice(0, 50) });
                    await get().refreshStatus();
                    await get().refreshRemoteInfo();
                    return result;
                } catch (e: unknown) {
                    set({ error: String(e) });
                    throw e;
                } finally {
                    set({ isCommitting: false });
                }
            },

            commitAndPush: async (message) => {
                await get().commit(message);
                await get().push();
            },

            // ── Push ─────────────────────────────────────────────────────────

            push: async () => {
                await get().checkGithubAuth({ silent: true });
                const { remoteInfo, githubToken, currentBranch } = get();
                const branch = currentBranch ?? remoteInfo?.current_branch ?? "main";
                const token = githubToken;
                if (!token) throw new Error("Not authenticated with GitHub. Connect your account first.");
                set({ isPushing: true, error: null });
                try {
                    await gitPush("origin", branch, token);
                    await get().refreshRemoteInfo({ fetch: true });
                } catch (e: unknown) {
                    set({ error: String(e) });
                    throw e;
                } finally {
                    set({ isPushing: false });
                }
            },

            // ── Branches ─────────────────────────────────────────────────────

            refreshBranches: async () => {
                if (!get().workspacePath) return;
                try {
                    const branches = await gitListBranches();
                    const current = branches.find((b) => b.is_current)?.name ?? null;
                    set({ branches, currentBranch: current });
                } catch {
                    // swallow — repo may have no commits yet
                }
            },

            createBranch: async (name, from) => {
                await gitCreateBranch(name, from);
                await get().refreshBranches();
            },

            checkoutBranch: async (name) => {
                await gitCheckoutBranch(name);
                set({ currentBranch: name });
                await get().refreshStatus();
                await get().refreshLog();
                await get().refreshRemoteInfo();
            },

            deleteBranch: async (name) => {
                await gitDeleteBranch(name);
                await get().refreshBranches();
            },

            // ── Remote ───────────────────────────────────────────────────────

            refreshRemoteInfo: async (options) => {
                if (!get().workspacePath) return;
                try {
                    let info = await gitGetRemoteInfo();
                    if (options?.fetch && info.remote_url) {
                        try {
                            await gitFetchRemote("origin", get().githubToken ?? null);
                            info = await gitGetRemoteInfo();
                        } catch {
                            // Keep existing info when fetch fails; common with private repos while signed out.
                        }
                    }
                    set({ remoteInfo: info });
                } catch {
                    set({ remoteInfo: null });
                }
            },

            setRemote: async (url) => {
                await gitSetRemote("origin", url);
                await get().refreshRemoteInfo();
                const { workspacePath, remoteInfo } = get();
                if (workspacePath) {
                    await gitStorageUpdateRemote(
                        workspacePath,
                        url,
                        remoteInfo?.owner ?? null,
                        remoteInfo?.repo ?? null
                    );
                }
            },

            // ── Log ──────────────────────────────────────────────────────────

            refreshLog: async (limit = 20) => {
                if (!get().workspacePath) return;
                try {
                    const commits = await gitGetLog(limit);
                    set({ recentCommits: commits });
                } catch {
                    // no commits yet
                }
            },

            // ── GitHub ───────────────────────────────────────────────────────

            setGithubUser: (user) => set({ githubUser: user }),

            checkGithubAuth: async (options) => {
                const silent = options?.silent ?? false;
                if (!silent) set({ isGithubAuthLoading: true });
                try {
                    const [user, token] = await Promise.all([
                        githubGetCurrentUser(),
                        githubGetToken(),
                    ]);
                    set({ githubUser: user, githubToken: token });
                } catch {
                    set({ githubUser: null, githubToken: null });
                } finally {
                    if (!silent) set({ isGithubAuthLoading: false });
                }
            },

            signOutGithub: async () => {
                set({ isGithubSigningOut: true });
                try {
                    await githubRevokeToken();
                    set({ githubUser: null, githubToken: null });
                    await get().checkGithubAuth({ silent: true });
                    await get().refreshRemoteInfo({ fetch: false });
                    set({ error: null });
                } catch (e: unknown) {
                    const message = String(e);
                    set({ error: message });
                    throw e;
                } finally {
                    set({ isGithubSigningOut: false });
                }
            },

            // ── Author ───────────────────────────────────────────────────────

            setAuthor: (author) => set({ author }),

            // ── UI ───────────────────────────────────────────────────────────

            setShowCreateBranchDialog: (v) => set({ showCreateBranchDialog: v }),
            setShowPrDialog: (v) => set({ showPrDialog: v }),
            setShowAuthDialog: (v) => set({ showAuthDialog: v }),
            setError: (err) => set({ error: err }),

            // ── Diff summary ─────────────────────────────────────────────────

            getDiffSummary: async () => {
                if (!get().workspacePath) return "";
                return gitGetDiffSummary();
            },
        }),
        {
            name: "pgstudio-git",
            partialize: (state) => ({
                workspacePath: state.workspacePath,
                workspaceConnectionId: state.workspaceConnectionId,
                savedWorkspaces: state.savedWorkspaces,
                author: state.author,
                githubUser: state.githubUser,
                recentCommits: state.recentCommits,
            }),
        }
    )
);
