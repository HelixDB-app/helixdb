use git2::{
    BranchType, ErrorCode, IndexAddOption, ObjectType, Repository, Signature, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

// ── Shared repo state ─────────────────────────────────────────────────────────

pub struct GitState {
    pub workspace_path: Mutex<Option<String>>,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            workspace_path: Mutex::new(None),
        }
    }
}

fn open_repo(state: &State<GitState>) -> Result<Repository, String> {
    let guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
    let path = guard
        .as_deref()
        .ok_or_else(|| "No workspace open. Call git_open_workspace first.".to_string())?;
    Repository::open(path).map_err(|e| format!("Failed to open repo: {e}"))
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "added" | "modified" | "deleted" | "untracked" | "renamed"
    pub staged: bool,
    pub old_path: Option<String>, // for renames
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitDiff {
    pub old_content: String,
    pub new_content: String,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub last_commit_message: Option<String>,
    pub last_commit_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitRemoteInfo {
    pub remote_url: Option<String>,
    pub owner: Option<String>,
    pub repo: Option<String>,
    pub current_branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceInfo {
    pub path: String,
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub has_remote: bool,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sanitize_connection_slug(id: &str) -> String {
    let mut s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        s = "default".to_string();
    }
    s.truncate(64);
    s
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn sanitize_path_segment(value: &str, fallback: &str) -> String {
    let mut out: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    out = out
        .trim_matches('.')
        .trim_matches('_')
        .trim_matches('-')
        .to_string();
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

fn default_workspace_path(host: &str, workspace_name: &str) -> PathBuf {
    crate::git_storage::pgstudio_data_dir()
        .join("projects")
        .join(sanitize_path_segment(host, "host"))
        .join(sanitize_path_segment(workspace_name, "workspace"))
}

/// Get or create a Git workspace path for the given DB connection and open it.
/// Uses app data dir so no user folder picker is needed; one workspace per connection.
#[tauri::command]
pub fn git_ensure_workspace_for_connection(
    connection_id: String,
    project_key: Option<String>,
    host: Option<String>,
    workspace_name: Option<String>,
    state: State<GitState>,
) -> Result<WorkspaceInfo, String> {
    let fallback_slug = sanitize_connection_slug(&connection_id);
    let normalized_project_key =
        normalize_non_empty(project_key).unwrap_or_else(|| format!("connection:{fallback_slug}"));
    let normalized_host = normalize_non_empty(host).unwrap_or_else(|| "connection".to_string());
    let normalized_workspace_name =
        normalize_non_empty(workspace_name).unwrap_or_else(|| fallback_slug.clone());

    let workspace_root = if let Some(existing) =
        crate::git_storage::get_workspace_by_project_key(&normalized_project_key)?
    {
        PathBuf::from(existing.path)
    } else {
        let legacy = crate::git_storage::pgstudio_data_dir()
            .join("git-workspaces")
            .join(&fallback_slug);
        if legacy.exists() {
            legacy
        } else {
            default_workspace_path(&normalized_host, &normalized_workspace_name)
        }
    };

    std::fs::create_dir_all(&workspace_root)
        .map_err(|e| format!("Failed to create workspace dir: {e}"))?;
    let path = workspace_root.to_string_lossy().to_string();
    git_open_workspace(
        path,
        Some(normalized_project_key),
        Some(normalized_host),
        Some(normalized_workspace_name),
        Some(connection_id),
        state,
    )
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Open or initialise a git repo at the given path.
#[tauri::command]
pub fn git_open_workspace(
    path: String,
    project_key: Option<String>,
    host: Option<String>,
    workspace_name: Option<String>,
    connection_id: Option<String>,
    state: State<GitState>,
) -> Result<WorkspaceInfo, String> {
    // Try to open existing repo; if that fails, initialise a new one.
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(e) if e.code() == ErrorCode::NotFound => {
            Repository::init(&path).map_err(|e2| format!("Failed to init repo: {e2}"))?
        }
        Err(e) => return Err(format!("Failed to open repo: {e}")),
    };

    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));
    let has_remote = repo.remotes().map(|r| r.len() > 0).unwrap_or(false);
    let is_git_repo = true;

    // Persist in state and SQLite
    {
        let mut guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        *guard = Some(path.clone());
    }
    crate::git_storage::save_workspace_with_project(
        &path,
        project_key.as_deref(),
        host.as_deref(),
        workspace_name.as_deref(),
        connection_id.as_deref(),
    )?;

    Ok(WorkspaceInfo {
        path,
        is_git_repo,
        current_branch,
        has_remote,
    })
}

/// Set the active workspace from a previously saved path (no init).
#[tauri::command]
pub fn git_set_workspace(path: String, state: State<GitState>) -> Result<WorkspaceInfo, String> {
    git_open_workspace(path, None, None, None, None, state)
}

/// Return status of all tracked and untracked files.
#[tauri::command]
pub fn git_get_status(state: State<GitState>) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&state)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut files = Vec::new();

    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or("").to_string();

        // Staged changes (index)
        if s.contains(git2::Status::INDEX_NEW) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "added".into(),
                staged: true,
                old_path: None,
            });
        } else if s.contains(git2::Status::INDEX_MODIFIED) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "modified".into(),
                staged: true,
                old_path: None,
            });
        } else if s.contains(git2::Status::INDEX_DELETED) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "deleted".into(),
                staged: true,
                old_path: None,
            });
        } else if s.contains(git2::Status::INDEX_RENAMED) {
            let old_path = entry
                .head_to_index()
                .and_then(|d| d.old_file().path())
                .map(|p| p.to_string_lossy().to_string());
            files.push(GitFileStatus {
                path: path.clone(),
                status: "renamed".into(),
                staged: true,
                old_path,
            });
        }

        // Unstaged / working-tree changes
        if s.contains(git2::Status::WT_NEW) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "untracked".into(),
                staged: false,
                old_path: None,
            });
        } else if s.contains(git2::Status::WT_MODIFIED) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "modified".into(),
                staged: false,
                old_path: None,
            });
        } else if s.contains(git2::Status::WT_DELETED) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "deleted".into(),
                staged: false,
                old_path: None,
            });
        } else if s.contains(git2::Status::WT_RENAMED) {
            files.push(GitFileStatus {
                path: path.clone(),
                status: "renamed".into(),
                staged: false,
                old_path: None,
            });
        }
    }

    Ok(files)
}

/// Return old and new content for a file so the Monaco DiffEditor can render it.
#[tauri::command]
pub fn git_get_diff(path: String, staged: bool, state: State<GitState>) -> Result<GitDiff, String> {
    let repo = open_repo(&state)?;
    let workdir = repo
        .workdir()
        .ok_or("Bare repository not supported")?
        .to_path_buf();
    let abs_path = workdir.join(&path);

    // New (working-tree or staged) content
    let new_content = if staged {
        // Read from index
        let index = repo.index().map_err(|e| e.to_string())?;
        if let Some(entry) = index.get_path(Path::new(&path), 0) {
            let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
            if blob.is_binary() {
                return Ok(GitDiff {
                    old_content: String::new(),
                    new_content: String::new(),
                    is_binary: true,
                });
            }
            String::from_utf8_lossy(blob.content()).to_string()
        } else {
            String::new()
        }
    } else {
        // Read from working tree
        if abs_path.exists() {
            std::fs::read_to_string(&abs_path).map_err(|e| format!("Cannot read file: {e}"))?
        } else {
            String::new()
        }
    };

    // Old (HEAD) content
    let old_content = match repo.head() {
        Ok(head_ref) => {
            let commit = head_ref.peel_to_commit().map_err(|e| e.to_string())?;
            let tree = commit.tree().map_err(|e| e.to_string())?;
            match tree.get_path(Path::new(&path)) {
                Ok(entry) => {
                    let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
                    if let Some(blob) = obj.as_blob() {
                        if blob.is_binary() {
                            return Ok(GitDiff {
                                old_content: String::new(),
                                new_content,
                                is_binary: true,
                            });
                        }
                        String::from_utf8_lossy(blob.content()).to_string()
                    } else {
                        String::new()
                    }
                }
                Err(_) => String::new(), // file didn't exist in HEAD
            }
        }
        Err(_) => String::new(), // initial commit / no HEAD
    };

    Ok(GitDiff {
        old_content,
        new_content,
        is_binary: false,
    })
}

/// Stage one or more files (git add).
#[tauri::command]
pub fn git_stage_files(paths: Vec<String>, state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for path in &paths {
        // If the file no longer exists, stage its removal
        let abs = repo.workdir().unwrap().join(path);
        if abs.exists() {
            index
                .add_path(Path::new(path))
                .map_err(|e| format!("stage {path}: {e}"))?;
        } else {
            index
                .remove_path(Path::new(path))
                .map_err(|e| format!("stage delete {path}: {e}"))?;
        }
    }
    index.write().map_err(|e| e.to_string())
}

/// Stage ALL changes (git add -A).
#[tauri::command]
pub fn git_stage_all(state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())
}

/// Unstage files (reset HEAD <path>).
#[tauri::command]
pub fn git_unstage_files(paths: Vec<String>, state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    // Check if HEAD exists without holding onto the reference object
    let has_head = repo.head().is_ok();
    if has_head {
        let head_ref = repo.head().map_err(|e| e.to_string())?;
        let commit = head_ref
            .peel(ObjectType::Commit)
            .map_err(|e| e.to_string())?;
        repo.reset_default(Some(&commit), paths.iter().map(|s| s.as_str()))
            .map_err(|e| e.to_string())
    } else {
        // No commits yet — just remove from index
        let mut index = repo.index().map_err(|e| e.to_string())?;
        for path in &paths {
            index.remove_path(Path::new(path)).ok();
        }
        index.write().map_err(|e| e.to_string())
    }
}

/// Commit the staged index.
#[tauri::command]
pub fn git_commit(
    message: String,
    author_name: String,
    author_email: String,
    state: State<GitState>,
) -> Result<GitCommit, String> {
    let repo = open_repo(&state)?;
    let sig = Signature::now(&author_name, &author_email).map_err(|e| format!("signature: {e}"))?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let commit_oid = match repo.head() {
        Ok(head_ref) => {
            let parent = head_ref.peel_to_commit().map_err(|e| e.to_string())?;
            repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&parent])
                .map_err(|e| e.to_string())?
        }
        Err(_) => {
            // Initial commit
            repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[])
                .map_err(|e| e.to_string())?
        }
    };

    let commit = repo.find_commit(commit_oid).map_err(|e| e.to_string())?;
    Ok(commit_to_dto(&commit))
}

/// Push to remote via HTTPS using a GitHub personal-access token.
#[tauri::command]
pub async fn git_push(
    remote_name: String,
    branch: String,
    token: String,
    state: State<'_, GitState>,
) -> Result<(), String> {
    let workspace_path = {
        let guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("No workspace open")?
    };
    // Spawn blocking because git2 is not async
    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&workspace_path).map_err(|e| e.to_string())?;
        let mut remote = repo.find_remote(&remote_name).map_err(|e| e.to_string())?;
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let mut callbacks = git2::RemoteCallbacks::new();
        callbacks.credentials(move |_url, _username, _allowed| {
            git2::Cred::userpass_plaintext("x-access-token", &token)
        });
        let mut push_opts = git2::PushOptions::new();
        push_opts.remote_callbacks(callbacks);
        remote
            .push(&[refspec.as_str()], Some(&mut push_opts))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch latest refs from a remote to keep ahead/behind and branch data accurate.
#[tauri::command]
pub async fn git_fetch_remote(
    remote_name: String,
    token: Option<String>,
    state: State<'_, GitState>,
) -> Result<(), String> {
    let workspace_path = {
        let guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("No workspace open")?
    };
    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&workspace_path).map_err(|e| e.to_string())?;
        let mut remote = repo.find_remote(&remote_name).map_err(|e| e.to_string())?;

        let mut fetch_opts = git2::FetchOptions::new();
        if let Some(auth_token) = token {
            let mut callbacks = git2::RemoteCallbacks::new();
            callbacks.credentials(move |_url, _username, _allowed| {
                git2::Cred::userpass_plaintext("x-access-token", &auth_token)
            });
            fetch_opts.remote_callbacks(callbacks);
        }

        remote
            .fetch(&[] as &[&str], Some(&mut fetch_opts), None)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add a remote or update if it exists.
#[tauri::command]
pub fn git_set_remote(
    remote_name: String,
    url: String,
    state: State<GitState>,
) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let remote_exists = repo.find_remote(&remote_name).is_ok();
    if remote_exists {
        repo.remote_set_url(&remote_name, &url)
            .map_err(|e| e.to_string())
    } else {
        repo.remote(&remote_name, &url).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// List local and remote branches.
#[tauri::command]
pub fn git_list_branches(state: State<GitState>) -> Result<Vec<GitBranch>, String> {
    let repo = open_repo(&state)?;
    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut branches = Vec::new();

    for entry in repo.branches(None).map_err(|e| e.to_string())? {
        let (branch, btype) = entry.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        let is_current = head_name.as_deref() == Some(name.as_str());
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));

        let (last_commit_message, last_commit_hash) = branch
            .get()
            .peel_to_commit()
            .ok()
            .map(|c| {
                (
                    c.message()
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                    c.id().to_string()[..7].to_string(),
                )
            })
            .unzip();

        branches.push(GitBranch {
            name,
            is_current,
            is_remote: btype == BranchType::Remote,
            upstream,
            last_commit_message,
            last_commit_hash,
        });
    }

    Ok(branches)
}

/// Create a new branch from a given ref (branch name or "HEAD").
#[tauri::command]
pub fn git_create_branch(
    name: String,
    from_ref: String,
    state: State<GitState>,
) -> Result<GitBranch, String> {
    let repo = open_repo(&state)?;
    let obj = repo
        .revparse_single(&from_ref)
        .map_err(|e| format!("revparse {from_ref}: {e}"))?;
    let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;
    let _branch = repo
        .branch(&name, &commit, false)
        .map_err(|e| format!("create branch: {e}"))?;

    Ok(GitBranch {
        name: name.clone(),
        is_current: false,
        is_remote: false,
        upstream: None,
        last_commit_message: Some(
            commit
                .message()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
        ),
        last_commit_hash: Some(commit.id().to_string()[..7].to_string()),
    })
}

/// Checkout a local branch.
#[tauri::command]
pub fn git_checkout_branch(name: String, state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let (object, reference) = repo
        .revparse_ext(&name)
        .map_err(|e| format!("revparse: {e}"))?;
    repo.checkout_tree(&object, None)
        .map_err(|e| format!("checkout_tree: {e}"))?;
    match reference {
        Some(gref) => repo
            .set_head(gref.name().unwrap_or(""))
            .map_err(|e| e.to_string()),
        None => repo
            .set_head_detached(object.id())
            .map_err(|e| e.to_string()),
    }
}

/// Delete a local branch (must not be current).
#[tauri::command]
pub fn git_delete_branch(name: String, state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let mut branch = repo
        .find_branch(&name, BranchType::Local)
        .map_err(|e| e.to_string())?;
    branch.delete().map_err(|e| e.to_string())
}

/// Recent commits on the current branch.
#[tauri::command]
pub fn git_get_log(limit: usize, state: State<GitState>) -> Result<Vec<GitCommit>, String> {
    let repo = open_repo(&state)?;
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(commit.id()).map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
        result.push(commit_to_dto(&c));
    }
    Ok(result)
}

/// Info about origin remote and ahead/behind counts.
#[tauri::command]
pub fn git_get_remote_info(state: State<GitState>) -> Result<GitRemoteInfo, String> {
    let repo = open_repo(&state)?;

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|s| s.to_string()));

    let (owner, repo_name) = remote_url
        .as_deref()
        .map(parse_github_remote)
        .unwrap_or((None, None));

    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let (ahead, behind) =
        if let (Some(branch_name), Ok(head)) = (current_branch.as_deref(), repo.head()) {
            let local = head.target().unwrap_or_else(git2::Oid::zero);
            let upstream_ref = format!("refs/remotes/origin/{branch_name}");
            if let Ok(upstream_oid) = repo.refname_to_id(&upstream_ref) {
                repo.graph_ahead_behind(local, upstream_oid)
                    .unwrap_or((0, 0))
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        };

    Ok(GitRemoteInfo {
        remote_url,
        owner,
        repo: repo_name,
        current_branch,
        ahead,
        behind,
    })
}

/// Generate a compact diff summary string (for AI prompt context).
#[tauri::command]
pub fn git_get_diff_summary(state: State<GitState>) -> Result<String, String> {
    let repo = open_repo(&state)?;
    let index = repo.index().map_err(|e| e.to_string())?;
    let index_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());

    let diff = repo
        .diff_tree_to_index(index_tree.as_ref(), Some(&index), None)
        .map_err(|e| e.to_string())?;

    let mut summary = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if summary.len() < 8000 {
            let content = std::str::from_utf8(line.content()).unwrap_or("");
            match line.origin() {
                '+' | '-' | ' ' => summary.push_str(&format!("{}{}", line.origin(), content)),
                _ => {}
            }
        }
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(summary)
}

/// Discard unstaged changes for a file (restore from HEAD or index).
#[tauri::command]
pub fn git_discard_changes(path: String, state: State<GitState>) -> Result<(), String> {
    let repo = open_repo(&state)?;
    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    checkout_opts.path(&path).force();
    repo.checkout_index(None, Some(&mut checkout_opts))
        .map_err(|e| e.to_string())
}

// ── Workspace file sync (IDE → disk for Git) ───────────────────────────────────

/// Reject relative_path that could escape workspace (e.g. ".." or absolute).
fn check_relative_path(relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("relative_path must not be empty".to_string());
    }
    if relative_path.starts_with('/') || relative_path.contains("..") {
        return Err("relative_path must not be absolute or contain '..'".to_string());
    }
    if relative_path
        .split('/')
        .any(|seg| seg == ".git" || seg == ".pgstudio")
    {
        return Err("relative_path must not target internal Git or metadata folders".to_string());
    }
    Ok(())
}

/// Write a file under the workspace. Creates parent dirs. Path must be under workspace.
#[tauri::command]
pub fn write_workspace_file(
    workspace_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    check_relative_path(&relative_path)?;
    let full = Path::new(&workspace_path).join(&relative_path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    std::fs::write(&full, content).map_err(|e| format!("write: {e}"))
}

/// Remove a file from the workspace if it exists.
#[tauri::command]
pub fn delete_workspace_file(workspace_path: String, relative_path: String) -> Result<(), String> {
    check_relative_path(&relative_path)?;
    let full = Path::new(&workspace_path).join(&relative_path);
    if full.exists() {
        std::fs::remove_file(&full).map_err(|e| format!("remove_file: {e}"))
    } else {
        Ok(())
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct IdeFileEntry {
    pub path: String,
    pub content: String,
}

const MANAGED_META_DIR: &str = ".pgstudio";
const MANAGED_FILE_INDEX: &str = ".pgstudio/managed-files.json";

fn normalize_relative_path(value: &str) -> String {
    value.trim().trim_start_matches('/').replace('\\', "/")
}

fn managed_file_index_path(workspace: &Path) -> PathBuf {
    workspace.join(MANAGED_FILE_INDEX)
}

fn load_managed_file_set(workspace: &Path) -> Result<HashSet<String>, String> {
    let path = managed_file_index_path(workspace);
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read managed file index: {e}"))?;
    let list: Vec<String> =
        serde_json::from_str(&raw).map_err(|e| format!("parse managed file index: {e}"))?;
    Ok(list.into_iter().collect())
}

fn store_managed_file_set(workspace: &Path, files: &HashSet<String>) -> Result<(), String> {
    let mut sorted = files.iter().cloned().collect::<Vec<String>>();
    sorted.sort();
    let dir = workspace.join(MANAGED_META_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create managed metadata dir: {e}"))?;
    let encoded = serde_json::to_string_pretty(&sorted)
        .map_err(|e| format!("serialize managed file index: {e}"))?;
    std::fs::write(managed_file_index_path(workspace), encoded)
        .map_err(|e| format!("write managed file index: {e}"))
}

fn prune_managed_files(
    workspace: &Path,
    previous: &HashSet<String>,
    current: &HashSet<String>,
) -> Result<(), String> {
    for path in previous.difference(current) {
        check_relative_path(path)?;
        let full = workspace.join(path);
        if full.exists() {
            std::fs::remove_file(&full)
                .map_err(|e| format!("remove stale managed file '{path}': {e}"))?;
            prune_empty_parent_dirs(workspace, full.parent());
        }
    }
    Ok(())
}

fn prune_empty_parent_dirs(workspace: &Path, start: Option<&Path>) {
    let mut cursor = start.map(Path::to_path_buf);
    while let Some(dir) = cursor {
        if dir == workspace {
            break;
        }
        match dir.read_dir() {
            Ok(mut it) => {
                if it.next().is_some() {
                    break;
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
}

/// Write all IDE file entries to the workspace; optionally remove files on disk not in the list.
#[tauri::command]
pub fn sync_ide_files_to_workspace(
    workspace_path: String,
    files: Vec<IdeFileEntry>,
) -> Result<(), String> {
    let workspace = Path::new(&workspace_path);
    let previous = load_managed_file_set(workspace)?;
    let mut written = HashSet::new();

    for entry in &files {
        let normalized_path = normalize_relative_path(&entry.path);
        check_relative_path(&normalized_path)?;
        let full = workspace.join(&normalized_path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
        }
        std::fs::write(&full, &entry.content)
            .map_err(|e| format!("write {normalized_path}: {e}"))?;
        written.insert(normalized_path);
    }

    // Remove only files that were previously managed by Explorer sync.
    prune_managed_files(workspace, &previous, &written)?;
    store_managed_file_set(workspace, &written)?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn commit_to_dto(c: &git2::Commit) -> GitCommit {
    let hash = c.id().to_string();
    let short_hash = hash[..7.min(hash.len())].to_string();
    let message = c
        .message()
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let author = c.author();
    let author_name = author.name().unwrap_or("").to_string();
    let author_email = author.email().unwrap_or("").to_string();
    let ts = c.time().seconds();
    let date = chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default();
    GitCommit {
        hash,
        short_hash,
        message,
        author_name,
        author_email,
        date,
    }
}

/// Parse "https://github.com/owner/repo.git" or "git@github.com:owner/repo.git"
pub fn parse_github_remote(url: &str) -> (Option<String>, Option<String>) {
    if let Some(rest) = url.strip_prefix("https://github.com/") {
        let clean = rest.trim_end_matches(".git");
        let parts: Vec<&str> = clean.splitn(2, '/').collect();
        if parts.len() == 2 {
            return (Some(parts[0].to_string()), Some(parts[1].to_string()));
        }
    } else if let Some(rest) = url.strip_prefix("git@github.com:") {
        let clean = rest.trim_end_matches(".git");
        let parts: Vec<&str> = clean.splitn(2, '/').collect();
        if parts.len() == 2 {
            return (Some(parts[0].to_string()), Some(parts[1].to_string()));
        }
    }
    (None, None)
}
