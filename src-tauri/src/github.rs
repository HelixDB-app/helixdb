use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub html_url: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub private: bool,
    pub description: Option<String>,
    pub default_branch: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubPullRequest {
    pub number: u64,
    pub html_url: String,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubCollaborator {
    pub login: String,
    pub avatar_url: String,
    pub html_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubBranch {
    pub name: String,
    pub protected: bool,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn github_api_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("pgStudio/1.0")
        .build()
        .expect("Failed to build reqwest client")
}

fn auth_header(token: &str) -> String {
    format!("Bearer {token}")
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

fn get_github_client_id() -> Result<String, String> {
    std::env::var("GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("GITHUB_CLIENT_ID").map(String::from))
        .and_then(|v| if v.is_empty() { None } else { Some(v) })
        .ok_or_else(|| "GITHUB_CLIENT_ID is not set. Add it to your project .env or to Application Support/pgstudio/.env (installed app).".to_string())
}

fn get_github_client_secret() -> Result<String, String> {
    std::env::var("GITHUB_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("GITHUB_CLIENT_SECRET").map(String::from))
        .and_then(|v| if v.is_empty() { None } else { Some(v) })
        .ok_or_else(|| "GITHUB_CLIENT_SECRET is not set. Add it to your project .env or to Application Support/pgstudio/.env (installed app).".to_string())
}

/// Open the user's browser to GitHub's OAuth authorization page.
/// Reads GITHUB_CLIENT_ID from the .env file loaded at app startup.
#[tauri::command]
pub async fn github_start_oauth(_app: AppHandle) -> Result<(), String> {
    let client_id = get_github_client_id()?;
    let url = format!(
        "https://github.com/login/oauth/authorize\
         ?client_id={client_id}\
         &redirect_uri=pgstudio%3A%2F%2Fgit%2Fcallback\
         &scope=repo%20user%3Aemail\
         &state=pgstudio_git"
    );
    opener::open(&url).map_err(|e| format!("Failed to open browser: {e}"))
}

/// Exchange the temporary code from GitHub's redirect for an access token.
/// Stores the token in the OS keychain.
#[tauri::command]
pub async fn github_exchange_code(code: String) -> Result<GithubUser, String> {
    let client_id = get_github_client_id()?;
    let client_secret = get_github_client_secret()?;

    let client = github_api_client();

    // Step 1: Exchange code for token
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }

    let resp: TokenResponse = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| format!("Token request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Token response parse failed: {e}"))?;

    if let Some(err) = resp.error {
        return Err(format!(
            "{err}: {}",
            resp.error_description.unwrap_or_default()
        ));
    }

    let token = resp
        .access_token
        .ok_or_else(|| "No access_token in response".to_string())?;

    // Step 2: Store token in keyring
    crate::git_storage::store_github_token(&token)?;

    // Step 3: Fetch and return user profile
    let user = fetch_github_user(&token).await?;
    Ok(user)
}

async fn fetch_github_user(token: &str) -> Result<GithubUser, String> {
    let client = github_api_client();
    let resp: serde_json::Value = client
        .get("https://api.github.com/user")
        .header("Authorization", auth_header(token))
        .send()
        .await
        .map_err(|e| format!("GitHub user fetch failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GitHub user parse failed: {e}"))?;

    Ok(GithubUser {
        login: resp["login"].as_str().unwrap_or("").to_string(),
        name: resp["name"].as_str().map(|s| s.to_string()),
        avatar_url: resp["avatar_url"].as_str().unwrap_or("").to_string(),
        html_url: resp["html_url"].as_str().unwrap_or("").to_string(),
        email: resp["email"].as_str().map(|s| s.to_string()),
    })
}

/// Retrieve current GitHub user using the stored token.
#[tauri::command]
pub async fn github_get_current_user() -> Result<Option<GithubUser>, String> {
    let token = match crate::git_storage::get_github_token()? {
        Some(t) => t,
        None => return Ok(None),
    };
    let user = fetch_github_user(&token).await?;
    Ok(Some(user))
}

/// Get the stored token (for display / pass-through to git push).
#[tauri::command]
pub async fn github_get_token() -> Result<Option<String>, String> {
    crate::git_storage::get_github_token()
}

/// Remove the stored token (sign out).
#[tauri::command]
pub async fn github_revoke_token() -> Result<(), String> {
    crate::git_storage::delete_github_token()
}

// ── Repository API ────────────────────────────────────────────────────────────

/// List repositories for the authenticated user (page 1, up to 100).
#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<GithubRepo>, String> {
    let token = crate::git_storage::get_github_token()?
        .ok_or_else(|| "Not authenticated with GitHub".to_string())?;

    let client = github_api_client();
    let resp: Vec<serde_json::Value> = client
        .get("https://api.github.com/user/repos")
        .header("Authorization", auth_header(&token))
        .query(&[("per_page", "100"), ("sort", "updated"), ("type", "owner")])
        .send()
        .await
        .map_err(|e| format!("List repos failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("List repos parse failed: {e}"))?;

    Ok(resp.iter().map(repo_from_json).collect())
}

/// Create a new repository under the authenticated user.
#[tauri::command]
pub async fn github_create_repo(
    name: String,
    description: Option<String>,
    private: bool,
) -> Result<GithubRepo, String> {
    let token = crate::git_storage::get_github_token()?
        .ok_or_else(|| "Not authenticated with GitHub".to_string())?;

    let client = github_api_client();
    let body = serde_json::json!({
        "name": name,
        "description": description.unwrap_or_default(),
        "private": private,
        "auto_init": false,
    });

    let resp: serde_json::Value = client
        .post("https://api.github.com/user/repos")
        .header("Authorization", auth_header(&token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Create repo failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Create repo parse failed: {e}"))?;

    if let Some(msg) = resp["message"].as_str() {
        return Err(format!("GitHub API error: {msg}"));
    }

    Ok(repo_from_json(&resp))
}

// ── Pull Request API ──────────────────────────────────────────────────────────

/// Create a pull request and return the PR object.
#[tauri::command]
pub async fn github_create_pr(
    owner: String,
    repo: String,
    title: String,
    body: Option<String>,
    head: String,
    base: String,
    reviewers: Vec<String>,
) -> Result<GithubPullRequest, String> {
    let token = crate::git_storage::get_github_token()?
        .ok_or_else(|| "Not authenticated with GitHub".to_string())?;

    let client = github_api_client();

    // Create the PR
    let pr_body = serde_json::json!({
        "title": title,
        "body": body.unwrap_or_default(),
        "head": head,
        "base": base,
    });

    let pr_resp: serde_json::Value = client
        .post(format!("https://api.github.com/repos/{owner}/{repo}/pulls"))
        .header("Authorization", auth_header(&token))
        .json(&pr_body)
        .send()
        .await
        .map_err(|e| format!("Create PR failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Create PR parse failed: {e}"))?;

    if let Some(msg) = pr_resp["message"].as_str() {
        return Err(format!("GitHub API error: {msg}"));
    }

    let pr_number = pr_resp["number"].as_u64().unwrap_or(0);

    // Request reviewers if any
    if !reviewers.is_empty() && pr_number > 0 {
        let _ = client
            .post(format!(
                "https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/requested_reviewers"
            ))
            .header("Authorization", auth_header(&token))
            .json(&serde_json::json!({ "reviewers": reviewers }))
            .send()
            .await;
    }

    Ok(GithubPullRequest {
        number: pr_number,
        html_url: pr_resp["html_url"].as_str().unwrap_or("").to_string(),
        title: pr_resp["title"].as_str().unwrap_or("").to_string(),
        body: pr_resp["body"].as_str().map(|s| s.to_string()),
        state: pr_resp["state"].as_str().unwrap_or("").to_string(),
        head_ref: pr_resp["head"]["ref"].as_str().unwrap_or("").to_string(),
        base_ref: pr_resp["base"]["ref"].as_str().unwrap_or("").to_string(),
    })
}

/// List collaborators of a repository (for reviewer selection).
#[tauri::command]
pub async fn github_list_collaborators(
    owner: String,
    repo: String,
) -> Result<Vec<GithubCollaborator>, String> {
    let token = crate::git_storage::get_github_token()?
        .ok_or_else(|| "Not authenticated with GitHub".to_string())?;

    let client = github_api_client();
    let resp: Vec<serde_json::Value> = client
        .get(format!(
            "https://api.github.com/repos/{owner}/{repo}/collaborators"
        ))
        .header("Authorization", auth_header(&token))
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|e| format!("List collaborators failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("List collaborators parse failed: {e}"))?;

    Ok(resp
        .iter()
        .map(|u| GithubCollaborator {
            login: u["login"].as_str().unwrap_or("").to_string(),
            avatar_url: u["avatar_url"].as_str().unwrap_or("").to_string(),
            html_url: u["html_url"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

/// List branches of a repository (for PR base selection).
#[tauri::command]
pub async fn github_list_remote_branches(
    owner: String,
    repo: String,
) -> Result<Vec<GithubBranch>, String> {
    let token = crate::git_storage::get_github_token()?
        .ok_or_else(|| "Not authenticated with GitHub".to_string())?;

    let client = github_api_client();
    let resp: Vec<serde_json::Value> = client
        .get(format!(
            "https://api.github.com/repos/{owner}/{repo}/branches"
        ))
        .header("Authorization", auth_header(&token))
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|e| format!("List branches failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("List branches parse failed: {e}"))?;

    Ok(resp
        .iter()
        .map(|b| GithubBranch {
            name: b["name"].as_str().unwrap_or("").to_string(),
            protected: b["protected"].as_bool().unwrap_or(false),
        })
        .collect())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn repo_from_json(v: &serde_json::Value) -> GithubRepo {
    GithubRepo {
        id: v["id"].as_u64().unwrap_or(0),
        name: v["name"].as_str().unwrap_or("").to_string(),
        full_name: v["full_name"].as_str().unwrap_or("").to_string(),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        clone_url: v["clone_url"].as_str().unwrap_or("").to_string(),
        ssh_url: v["ssh_url"].as_str().unwrap_or("").to_string(),
        private: v["private"].as_bool().unwrap_or(false),
        description: v["description"].as_str().map(|s| s.to_string()),
        default_branch: v["default_branch"].as_str().unwrap_or("main").to_string(),
    }
}
