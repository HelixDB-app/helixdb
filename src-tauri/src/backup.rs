use crate::backup_storage::{
    self, BackupArtifact, BackupCloudSyncStatus, BackupGoogleDriveConfigInput,
    BackupGoogleDriveRuntime, BackupGoogleDriveStatus, BackupRecord, BackupRecordStatus,
    BackupSchedule, BackupScope,
};
use crate::commands::AppState;
use crate::connections_storage::SshTunnelConfig;
use chrono::{Datelike, Local, Timelike};
use dashmap::DashSet;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::time::{timeout, Duration, Instant};

static RUNNING_SCHEDULES: Lazy<DashSet<String>> = Lazy::new(DashSet::new);
static URI_DB_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(postgres(?:ql)?://[^/]+/)([^?#]*)(.*)$").expect("valid db regex")
});
static DSN_DB_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bdbname=('[^']*'|\S+)").expect("valid dsn regex"));

const BACKUP_PROGRESS_EVENT: &str = "backup-job-progress";
const RESTORE_PROGRESS_EVENT: &str = "backup-restore-progress";
const MODULE_CHANGED_EVENT: &str = "backup-module-changed";
const GOOGLE_DRIVE_ROOT_FOLDER_NAME: &str = "HelixDB Backups";
const GOOGLE_DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_OAUTH_SCOPE: &str =
    "https://www.googleapis.com/auth/drive.file openid email profile";
const GOOGLE_OAUTH_TIMEOUT_SECS: u64 = 180;
const GOOGLE_UPLOAD_CHUNK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSizeEstimateItem {
    pub database_name: String,
    pub estimated_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSizeEstimate {
    pub scope: BackupScope,
    pub estimated_bytes: u64,
    pub database_breakdown: Vec<BackupSizeEstimateItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupCapabilities {
    pub ready_for_backup: bool,
    pub ready_for_restore: bool,
    pub psql_path: Option<String>,
    pub psql_version: Option<String>,
    pub pg_dump_path: Option<String>,
    pub pg_dump_version: Option<String>,
    pub pg_restore_path: Option<String>,
    pub pg_restore_version: Option<String>,
    pub pg_dumpall_path: Option<String>,
    pub pg_dumpall_version: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupModuleState {
    pub backups: Vec<BackupRecord>,
    pub schedules: Vec<BackupSchedule>,
    pub default_output_root: String,
    pub google_drive: BackupGoogleDriveStatus,
    pub capabilities: BackupCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRunRequest {
    #[serde(default)]
    pub connection_id: Option<String>,
    pub connection_label: String,
    pub connection_string: String,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    pub scope: BackupScope,
    #[serde(default)]
    pub source_database: Option<String>,
    #[serde(default)]
    pub output_root: Option<String>,
    #[serde(default)]
    pub sync_to_google_drive: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub estimated_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreRequest {
    pub backup_id: String,
    pub connection_string: String,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    pub target_database: String,
    #[serde(default)]
    pub source_database: Option<String>,
    #[serde(default)]
    pub create_database_if_missing: bool,
    #[serde(default)]
    pub clean_restore: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub backup_id: String,
    pub target_database: String,
    pub restored_artifact: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupScheduleInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub cron: String,
    pub scope: BackupScope,
    #[serde(default)]
    pub source_database: Option<String>,
    pub connection_label: String,
    pub connection_string: String,
    #[serde(default)]
    pub output_root: Option<String>,
    #[serde(default)]
    pub sync_to_google_drive: bool,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgressPayload {
    pub job_id: String,
    pub kind: String,
    pub phase: String,
    pub message: String,
    pub current: u32,
    pub total: u32,
    pub percent: f32,
    #[serde(default)]
    pub bytes_written: Option<u64>,
    #[serde(default)]
    pub estimated_bytes: Option<u64>,
    #[serde(default)]
    pub artifact_label: Option<String>,
}

#[derive(Debug, Clone)]
struct PgClientTools {
    psql: Option<PathBuf>,
    pg_dump: Option<PathBuf>,
    pg_restore: Option<PathBuf>,
    pg_dumpall: Option<PathBuf>,
    psql_version: Option<String>,
    pg_dump_version: Option<String>,
    pg_restore_version: Option<String>,
    pg_dumpall_version: Option<String>,
}

#[derive(Debug, Clone)]
struct CliConnection {
    dsn: String,
    password: Option<String>,
}

#[derive(Debug, Clone)]
struct BackupExecutionPlan {
    backup_id: String,
    backup_name: String,
    scope: BackupScope,
    source_database: Option<String>,
    connection_label: String,
    effective_connection_string: String,
    output_root: String,
    backup_dir: PathBuf,
    sync_to_google_drive: bool,
    estimated_bytes: Option<u64>,
    triggered_by: String,
    schedule_id: Option<String>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn normalize_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn sanitize_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() { ch } else { '-' };
        if next == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(next.to_ascii_lowercase());
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "backup".to_string()
    } else {
        trimmed
    }
}

fn binary_name(binary: &str) -> String {
    #[cfg(windows)]
    {
        format!("{}.exe", binary)
    }
    #[cfg(not(windows))]
    {
        binary.to_string()
    }
}

fn run_version_command(path: &Path) -> Option<String> {
    StdCommand::new(path)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn major_from_version(version: &str) -> Option<u32> {
    version
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .collect::<String>()
        .split('.')
        .next()
        .and_then(|item| item.parse::<u32>().ok())
}

fn which(binary: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";

    StdCommand::new(finder)
        .arg(binary)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|line| PathBuf::from(line.trim()))
        })
        .filter(|path| path.exists())
}

fn common_pg_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/usr/lib/postgresql/17/bin"),
        PathBuf::from("/usr/lib/postgresql/16/bin"),
        PathBuf::from("/usr/lib/postgresql/15/bin"),
        PathBuf::from("/usr/lib/postgresql/14/bin"),
        PathBuf::from(r"C:\Program Files\PostgreSQL\17\bin"),
        PathBuf::from(r"C:\Program Files\PostgreSQL\16\bin"),
        PathBuf::from(r"C:\Program Files\PostgreSQL\15\bin"),
    ]
}

fn find_pg_binary(binary: &str) -> Option<PathBuf> {
    if let Some(path) = which(binary) {
        return Some(path);
    }

    let exec_name = binary_name(binary);
    if let Some(psql_path) = which("psql") {
        let sibling = psql_path.with_file_name(&exec_name);
        if sibling.exists() {
            return Some(sibling);
        }
    }

    common_pg_dirs()
        .into_iter()
        .map(|dir| dir.join(&exec_name))
        .find(|path| path.exists())
}

fn detect_pg_clients() -> PgClientTools {
    let psql = find_pg_binary("psql");
    let pg_dump = find_pg_binary("pg_dump");
    let pg_restore = find_pg_binary("pg_restore");
    let pg_dumpall = find_pg_binary("pg_dumpall");

    PgClientTools {
        psql_version: psql.as_deref().and_then(run_version_command),
        pg_dump_version: pg_dump.as_deref().and_then(run_version_command),
        pg_restore_version: pg_restore.as_deref().and_then(run_version_command),
        pg_dumpall_version: pg_dumpall.as_deref().and_then(run_version_command),
        psql,
        pg_dump,
        pg_restore,
        pg_dumpall,
    }
}

fn backup_capabilities() -> BackupCapabilities {
    let tools = detect_pg_clients();
    let mut notes = Vec::new();

    if tools.pg_dump.is_none() {
        notes.push(
            "`pg_dump` was not found. Install PostgreSQL client tools to enable backups."
                .to_string(),
        );
    }
    if tools.pg_restore.is_none() {
        notes.push("`pg_restore` was not found. Restore actions will stay disabled until PostgreSQL client tools are installed.".to_string());
    }
    if tools.pg_dumpall.is_none() {
        notes.push("`pg_dumpall` was not found. Cluster backups need the full PostgreSQL client toolchain.".to_string());
    }

    if let (Some(dump), Some(restore)) = (&tools.pg_dump_version, &tools.pg_restore_version) {
        let dump_major = major_from_version(dump);
        let restore_major = major_from_version(restore);
        if dump_major.is_some() && restore_major.is_some() && dump_major != restore_major {
            notes.push("`pg_dump` and `pg_restore` are different major versions. Backups still run, but matching versions are safer.".to_string());
        }
    }

    BackupCapabilities {
        ready_for_backup: tools.pg_dump.is_some() && tools.psql.is_some(),
        ready_for_restore: tools.pg_restore.is_some() && tools.psql.is_some(),
        psql_path: tools.psql.map(|p| p.to_string_lossy().to_string()),
        psql_version: tools.psql_version,
        pg_dump_path: tools.pg_dump.map(|p| p.to_string_lossy().to_string()),
        pg_dump_version: tools.pg_dump_version,
        pg_restore_path: tools.pg_restore.map(|p| p.to_string_lossy().to_string()),
        pg_restore_version: tools.pg_restore_version,
        pg_dumpall_path: tools.pg_dumpall.map(|p| p.to_string_lossy().to_string()),
        pg_dumpall_version: tools.pg_dumpall_version,
        notes,
    }
}

fn extract_query_param(raw: &str, key: &str) -> Option<String> {
    let query = raw.split_once('?')?.1;
    for pair in query.split('&') {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if raw_key.eq_ignore_ascii_case(key) {
            return Some(raw_value.replace('+', " "));
        }
    }
    None
}

fn quote_conn_value(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':'))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

fn build_cli_connection(connection_string: &str) -> Result<CliConnection, String> {
    let cfg = connection_string
        .parse::<tokio_postgres::Config>()
        .map_err(|e| format!("Invalid connection string: {}", e))?;

    let host = cfg
        .get_hosts()
        .first()
        .map(|host| match host {
            tokio_postgres::config::Host::Tcp(value) => value.clone(),
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(path) => path.to_string_lossy().to_string(),
        })
        .unwrap_or_else(|| "localhost".to_string());
    let port = cfg.get_ports().first().copied().unwrap_or(5432);
    let dbname = cfg
        .get_dbname()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "postgres".to_string());
    let user = cfg
        .get_user()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "postgres".to_string());
    let password = cfg
        .get_password()
        .map(|raw| String::from_utf8_lossy(raw).to_string());

    let mut parts = vec![
        format!("host={}", quote_conn_value(&host)),
        format!("port={}", port),
        format!("user={}", quote_conn_value(&user)),
        format!("dbname={}", quote_conn_value(&dbname)),
    ];

    for key in [
        "sslmode",
        "sslrootcert",
        "sslcert",
        "sslkey",
        "target_session_attrs",
        "connect_timeout",
        "application_name",
    ] {
        if let Some(value) = extract_query_param(connection_string, key) {
            parts.push(format!("{}={}", key, quote_conn_value(&value)));
        }
    }

    Ok(CliConnection {
        dsn: parts.join(" "),
        password,
    })
}

fn replace_database_in_connection_string(raw: &str, database_name: &str) -> String {
    if URI_DB_RE.is_match(raw) {
        return URI_DB_RE
            .replace(raw, format!("${{1}}{}${{3}}", database_name))
            .to_string();
    }

    if DSN_DB_RE.is_match(raw) {
        let replacement = format!("dbname={}", quote_conn_value(database_name));
        return DSN_DB_RE.replace(raw, replacement).to_string();
    }

    format!("{raw} dbname={}", quote_conn_value(database_name))
}

fn database_exists_sql(database_name: &str) -> String {
    format!(
        "SELECT 1 FROM pg_database WHERE datname = '{}';",
        database_name.replace('\'', "''")
    )
}

fn create_database_sql(database_name: &str) -> String {
    format!(
        "CREATE DATABASE \"{}\";",
        database_name.replace('"', "\"\"")
    )
}

fn emit_progress(app: &AppHandle, event: &str, payload: &BackupProgressPayload) {
    let _ = app.emit(event, payload);
}

fn backup_progress(
    app: &AppHandle,
    job_id: &str,
    phase: &str,
    message: impl Into<String>,
    current: u32,
    total: u32,
    estimated_bytes: Option<u64>,
    bytes_written: Option<u64>,
    artifact_label: Option<String>,
) {
    let safe_total = total.max(1);
    emit_progress(
        app,
        BACKUP_PROGRESS_EVENT,
        &BackupProgressPayload {
            job_id: job_id.to_string(),
            kind: "backup".to_string(),
            phase: phase.to_string(),
            message: message.into(),
            current,
            total: safe_total,
            percent: ((current as f32) / (safe_total as f32) * 100.0).min(100.0),
            estimated_bytes,
            bytes_written,
            artifact_label,
        },
    );
}

fn restore_progress(
    app: &AppHandle,
    job_id: &str,
    phase: &str,
    message: impl Into<String>,
    current: u32,
    total: u32,
    artifact_label: Option<String>,
) {
    let safe_total = total.max(1);
    emit_progress(
        app,
        RESTORE_PROGRESS_EVENT,
        &BackupProgressPayload {
            job_id: job_id.to_string(),
            kind: "restore".to_string(),
            phase: phase.to_string(),
            message: message.into(),
            current,
            total: safe_total,
            percent: ((current as f32) / (safe_total as f32) * 100.0).min(100.0),
            estimated_bytes: None,
            bytes_written: None,
            artifact_label,
        },
    );
}

fn emit_module_changed(app: &AppHandle) {
    let _ = app.emit(MODULE_CHANGED_EVENT, json!({ "at": now_ms() }));
}

fn backup_dir_for_plan(
    output_root: &str,
    scope: BackupScope,
    name: &str,
    backup_id: &str,
) -> PathBuf {
    let now = Local::now();
    let slug = sanitize_name(name);
    PathBuf::from(output_root)
        .join(scope.as_str())
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{:02}", now.day()))
        .join(format!(
            "{}-{}-{}",
            now.format("%H%M%S"),
            slug,
            &backup_id.chars().take(8).collect::<String>()
        ))
}

fn default_backup_name(
    scope: BackupScope,
    connection_label: &str,
    source_database: Option<&str>,
) -> String {
    let ts = Local::now().format("%Y-%m-%d %H:%M");
    match scope {
        BackupScope::Database => format!(
            "{} database backup {}",
            source_database.unwrap_or(connection_label),
            ts
        ),
        BackupScope::Cluster => format!("{} cluster backup {}", connection_label, ts),
    }
}

fn write_manifest(record: &BackupRecord) -> Result<(), String> {
    let manifest_path = Path::new(&record.backup_dir).join("manifest.json");
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    fs::write(&manifest_path, json).map_err(|e| format!("Failed to write manifest: {}", e))?;
    Ok(())
}

async fn run_cli_output(
    program: &Path,
    cli: &CliConnection,
    args: &[String],
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(password) = &cli.password {
        command.env("PGPASSWORD", password);
    }
    command
        .output()
        .await
        .map_err(|e| format!("Failed to launch {}: {}", program.to_string_lossy(), e))
}

async fn run_cli_status(
    program: &Path,
    cli: &CliConnection,
    args: &[String],
) -> Result<(), String> {
    let output = run_cli_output(program, cli, args).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

async fn list_cluster_databases(
    tools: &PgClientTools,
    connection_string: &str,
) -> Result<Vec<String>, String> {
    let psql = tools
        .psql
        .as_ref()
        .ok_or("`psql` is required to enumerate cluster databases")?;
    let cli = build_cli_connection(connection_string)?;
    let args = vec![
        "--no-align".to_string(),
        "--tuples-only".to_string(),
        "--quiet".to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
        "-c".to_string(),
        "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname;".to_string(),
    ];
    let output = run_cli_output(psql, &cli, &args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to list databases for cluster backup.".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

async fn run_pg_dump(
    tools: &PgClientTools,
    connection_string: &str,
    output_path: &Path,
) -> Result<u64, String> {
    let pg_dump = tools
        .pg_dump
        .as_ref()
        .ok_or("`pg_dump` was not found. Install PostgreSQL client tools first.")?;
    let cli = build_cli_connection(connection_string)?;
    let args = vec![
        "--format=custom".to_string(),
        "--compress=6".to_string(),
        "--no-owner".to_string(),
        "--no-privileges".to_string(),
        "--file".to_string(),
        output_path.to_string_lossy().to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
    ];
    run_cli_status(pg_dump, &cli, &args).await?;
    fs::metadata(output_path)
        .map(|meta| meta.len())
        .map_err(|e| format!("Failed to read backup file metadata: {}", e))
}

async fn run_pg_dumpall_globals(
    tools: &PgClientTools,
    connection_string: &str,
    output_path: &Path,
) -> Result<u64, String> {
    let pg_dumpall = tools.pg_dumpall.as_ref().ok_or(
        "`pg_dumpall` was not found. Cluster backups need the full PostgreSQL client toolchain.",
    )?;
    let cli = build_cli_connection(connection_string)?;
    let args = vec![
        "--globals-only".to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
    ];
    let output = run_cli_output(pg_dumpall, &cli, &args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to capture cluster globals.".to_string()
        } else {
            stderr
        });
    }

    let file = fs::File::create(output_path)
        .map_err(|e| format!("Failed to create globals archive: {}", e))?;
    let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    encoder
        .write_all(&output.stdout)
        .map_err(|e| format!("Failed to write globals archive: {}", e))?;
    encoder
        .finish()
        .map_err(|e| format!("Failed to finalize globals archive: {}", e))?;

    fs::metadata(output_path)
        .map(|meta| meta.len())
        .map_err(|e| format!("Failed to stat globals archive: {}", e))
}

async fn ensure_database_exists(
    tools: &PgClientTools,
    connection_string: &str,
    target_database: &str,
) -> Result<(), String> {
    let psql = tools
        .psql
        .as_ref()
        .ok_or("`psql` is required to validate restore targets")?;
    let admin_conn = replace_database_in_connection_string(connection_string, "postgres");
    let cli = build_cli_connection(&admin_conn)?;

    let exists_args = vec![
        "--no-align".to_string(),
        "--tuples-only".to_string(),
        "--quiet".to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
        "-c".to_string(),
        database_exists_sql(target_database),
    ];
    let output = run_cli_output(psql, &cli, &exists_args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to validate the restore target database.".to_string()
        } else {
            stderr
        });
    }
    let exists = String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim() == "1");
    if exists {
        return Ok(());
    }

    let create_args = vec![
        "--quiet".to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
        "-c".to_string(),
        create_database_sql(target_database),
    ];
    run_cli_status(psql, &cli, &create_args).await
}

async fn run_pg_restore_custom(
    tools: &PgClientTools,
    connection_string: &str,
    archive_path: &Path,
    clean_restore: bool,
) -> Result<(), String> {
    let pg_restore = tools
        .pg_restore
        .as_ref()
        .ok_or("`pg_restore` was not found. Restore requires PostgreSQL client tools.")?;
    let cli = build_cli_connection(connection_string)?;
    let mut args = vec![
        "--no-owner".to_string(),
        "--no-privileges".to_string(),
        "--dbname".to_string(),
        cli.dsn.clone(),
    ];
    if clean_restore {
        args.push("--clean".to_string());
        args.push("--if-exists".to_string());
    }
    args.push(archive_path.to_string_lossy().to_string());
    run_cli_status(pg_restore, &cli, &args).await
}

fn maybe_open_ssh_tunnel(
    app: &AppHandle,
    connection_string: &str,
    ssh_tunnel: &Option<SshTunnelConfig>,
    tunnel_id: &str,
) -> Result<Option<String>, String> {
    let Some(config) = ssh_tunnel else {
        return Ok(None);
    };
    if !config.use_ssh_tunneling {
        return Ok(None);
    }

    let parsed = connection_string
        .parse::<tokio_postgres::Config>()
        .map_err(|e| format!("Invalid connection string: {}", e))?;
    let db_host = parsed
        .get_hosts()
        .first()
        .map(|host| match host {
            tokio_postgres::config::Host::Tcp(value) => value.clone(),
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(path) => path.to_string_lossy().to_string(),
        })
        .unwrap_or_else(|| "localhost".to_string());
    let db_port = parsed.get_ports().first().copied().unwrap_or(5432);

    let state: State<'_, AppState> = app.state();
    let local_port = state
        .ssh_tunnel_manager
        .start(tunnel_id, config, &db_host, db_port)?;
    Ok(Some(replace_port_host(
        connection_string,
        "127.0.0.1",
        local_port,
    )))
}

fn close_ssh_tunnel(app: &AppHandle, tunnel_id: &str) {
    let state: State<'_, AppState> = app.state();
    let _ = state.ssh_tunnel_manager.stop(tunnel_id);
}

fn replace_port_host(connection_string: &str, host: &str, port: u16) -> String {
    let config = match connection_string.parse::<tokio_postgres::Config>() {
        Ok(cfg) => cfg,
        Err(_) => return connection_string.to_string(),
    };
    let user = config
        .get_user()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "postgres".to_string());
    let password = config
        .get_password()
        .map(|raw| String::from_utf8_lossy(raw).to_string())
        .unwrap_or_default();
    let dbname = config
        .get_dbname()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "postgres".to_string());
    if password.is_empty() {
        format!(
            "host={} port={} user={} dbname={}",
            host, port, user, dbname
        )
    } else {
        format!(
            "host={} port={} user={} password={} dbname={}",
            host, port, user, password, dbname
        )
    }
}

async fn upload_backup_to_google_drive(
    app: &AppHandle,
    backup: &mut BackupRecord,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().ok();
    let mut runtime = backup_storage::load_google_drive_runtime(app_data_dir.clone())?
        .ok_or("Google Drive is not configured for backup sync.")?;
    let folder_id = runtime
        .config
        .folder_id
        .clone()
        .ok_or("Google Drive folder id is missing.")?;
    let access_token = ensure_google_access_token(app, &mut runtime).await?;

    let client = google_http_client()?;
    let drive_folder_id =
        create_drive_folder(&client, &access_token, Some(&folder_id), &backup.name).await?;
    for artifact in &mut backup.artifacts {
        let mime = if artifact.format == "sql_gzip" {
            "application/gzip"
        } else {
            "application/octet-stream"
        };
        let file_id = upload_drive_file(
            &client,
            &access_token,
            &drive_folder_id,
            Path::new(&artifact.absolute_path),
            mime,
        )
        .await?;
        artifact.google_drive_file_id = Some(file_id);
    }
    write_manifest(backup)?;
    let manifest_path = Path::new(&backup.backup_dir).join("manifest.json");
    let _ = upload_drive_file(
        &client,
        &access_token,
        &drive_folder_id,
        &manifest_path,
        "application/json",
    )
    .await?;
    backup.cloud_sync_status = Some(BackupCloudSyncStatus::Synced);
    backup.cloud_sync_message = Some("Uploaded to Google Drive.".to_string());
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleDriveAboutResponse {
    user: Option<GoogleDriveUser>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfoResponse {
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleDriveUser {
    display_name: Option<String>,
    email_address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleDriveListResponse {
    #[serde(default)]
    files: Vec<GoogleDriveFileItem>,
}

#[derive(Debug, Deserialize)]
struct GoogleDriveFileItem {
    id: Option<String>,
}

#[derive(Debug)]
struct GoogleOAuthCallback {
    code: String,
    stream: TcpStream,
}

fn google_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("HelixDB/1.0")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create Google HTTP client: {}", e))
}

fn get_google_drive_client_id() -> Result<String, String> {
    [
        std::env::var("GOOGLE_DRIVE_CLIENT_ID").ok(),
        std::env::var("GOOGLE_DRIVE_OAUTH_CLIENT_ID").ok(),
        option_env!("GOOGLE_DRIVE_CLIENT_ID").map(String::from),
        option_env!("GOOGLE_DRIVE_OAUTH_CLIENT_ID").map(String::from),
    ]
    .into_iter()
    .flatten()
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
    .ok_or_else(|| {
        "GOOGLE_DRIVE_CLIENT_ID is not set. Add it to your project .env or to Application Support/pgstudio/.env before connecting Google Drive.".to_string()
    })
}

fn get_google_drive_client_secret() -> Option<String> {
    [
        std::env::var("GOOGLE_DRIVE_CLIENT_SECRET").ok(),
        std::env::var("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET").ok(),
        option_env!("GOOGLE_DRIVE_CLIENT_SECRET").map(String::from),
        option_env!("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET").map(String::from),
    ]
    .into_iter()
    .flatten()
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
}

fn build_google_pkce_pair() -> (String, String) {
    let verifier = format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64_url_encode(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn base64_url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let value =
            ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        output.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 6) & 0x3f) as usize] as char);
        output.push(TABLE[(value & 0x3f) as usize] as char);
    }

    let remainder = chunks.remainder();
    if remainder.len() == 1 {
        let value = (remainder[0] as u32) << 16;
        output.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
    } else if remainder.len() == 2 {
        let value = ((remainder[0] as u32) << 16) | ((remainder[1] as u32) << 8);
        output.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 6) & 0x3f) as usize] as char);
    }

    output
}

fn google_drive_folder_url(folder_id: &str) -> String {
    format!("https://drive.google.com/drive/folders/{}", folder_id)
}

fn build_google_oauth_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| format!("Failed to build Google OAuth URL: {}", e))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", GOOGLE_DRIVE_OAUTH_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.to_string())
}

fn google_oauth_response_html(title: &str, message: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\n\r\n<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#09121f;color:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}}main{{max-width:460px;background:rgba(15,23,42,.88);border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:28px;box-shadow:0 24px 64px rgba(2,6,23,.32)}}h1{{font-size:22px;margin:0 0 12px}}p{{margin:0;color:#cbd5e1;line-height:1.6}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"
    )
}

async fn reply_google_oauth_page(stream: &mut TcpStream, title: &str, message: &str) {
    let _ = stream
        .write_all(google_oauth_response_html(title, message).as_bytes())
        .await;
}

fn parse_http_request_target(request: &str) -> Option<String> {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .map(str::to_string)
}

async fn wait_for_google_oauth_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<GoogleOAuthCallback, String> {
    let deadline = Instant::now() + Duration::from_secs(GOOGLE_OAUTH_TIMEOUT_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Google Drive sign-in timed out. Try connecting again.".to_string());
        }

        let (mut stream, _) = timeout(remaining, listener.accept())
            .await
            .map_err(|_| "Google Drive sign-in timed out. Try connecting again.".to_string())?
            .map_err(|e| format!("Failed to receive Google OAuth callback: {}", e))?;

        let mut buffer = [0u8; 8192];
        let bytes_read = match timeout(Duration::from_secs(5), stream.read(&mut buffer)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(err)) => {
                if err.kind() == ErrorKind::UnexpectedEof {
                    continue;
                }
                return Err(format!("Failed to read Google OAuth callback: {}", err));
            }
            Err(_) => continue,
        };

        if bytes_read == 0 {
            continue;
        }

        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        let Some(target) = parse_http_request_target(&request) else {
            continue;
        };
        let callback_url = match reqwest::Url::parse(&format!("http://127.0.0.1{}", target)) {
            Ok(url) => url,
            Err(_) => continue,
        };

        let code = callback_url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then_some(value.into_owned()));
        let state = callback_url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then_some(value.into_owned()));
        let error = callback_url
            .query_pairs()
            .find_map(|(key, value)| (key == "error").then_some(value.into_owned()));

        if code.is_none() && error.is_none() {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
            continue;
        }

        if state.as_deref() != Some(expected_state) {
            reply_google_oauth_page(
                &mut stream,
                "HelixDB Google Drive Sign-In Failed",
                "The sign-in response could not be verified. Return to HelixDB and try again.",
            )
            .await;
            return Err(
                "Google Drive sign-in could not be verified. Please retry the connection flow."
                    .to_string(),
            );
        }

        if let Some(err) = error {
            reply_google_oauth_page(
                &mut stream,
                "HelixDB Google Drive Sign-In Cancelled",
                "Google did not grant Drive access. You can close this window and return to HelixDB.",
            )
            .await;
            return Err(match err.as_str() {
                "access_denied" => {
                    "Google Drive access was denied. Connect again when you’re ready.".to_string()
                }
                _ => format!("Google Drive sign-in failed: {}", err),
            });
        }

        let code = code.ok_or("Google Drive sign-in did not return an authorization code.")?;
        return Ok(GoogleOAuthCallback { code, stream });
    }
}

async fn exchange_google_oauth_code(
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> Result<GoogleTokenResponse, String> {
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", code_verifier.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];
    if let Some(client_secret) = get_google_drive_client_secret() {
        form.push(("client_secret", client_secret));
    }

    let response = google_http_client()?
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Google token exchange failed: {}", e))?;

    let status = response.status();
    let body: GoogleTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google token response: {}", e))?;

    if !status.is_success() {
        let missing_secret = body
            .error_description
            .as_deref()
            .or(body.error.as_deref())
            .map(|message| message.contains("client_secret"))
            .unwrap_or(false);
        if missing_secret && get_google_drive_client_secret().is_none() {
            return Err(
                "Google requires a client secret for this OAuth client. Add GOOGLE_DRIVE_CLIENT_SECRET to your app .env or switch to a Desktop app OAuth client."
                    .to_string(),
            );
        }
        return Err(body
            .error_description
            .or(body.error)
            .unwrap_or_else(|| format!("Google token exchange failed ({})", status)));
    }

    Ok(body)
}

async fn fetch_google_user_info(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Option<GoogleUserInfoResponse>, String> {
    let response = client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to load Google account details: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::warn!(
            "[backup] Google account lookup failed with status {}: {}",
            status,
            body
        );
        return Ok(None);
    }

    let body: GoogleUserInfoResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google account details: {}", e))?;
    Ok(Some(body))
}

async fn fetch_google_drive_user(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Option<GoogleDriveUser>, String> {
    let response = client
        .get("https://www.googleapis.com/drive/v3/about")
        .bearer_auth(access_token)
        .query(&[("fields", "user(displayName,emailAddress)")])
        .send()
        .await
        .map_err(|e| format!("Failed to load Google Drive account details: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::warn!(
            "[backup] Google Drive about lookup failed with status {}: {}",
            status,
            body
        );
        return Ok(None);
    }

    let body: GoogleDriveAboutResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Drive account details: {}", e))?;
    Ok(body.user)
}

async fn find_drive_folder(
    client: &reqwest::Client,
    access_token: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let query = format!(
        "mimeType = 'application/vnd.google-apps.folder' and name = '{}' and trashed = false",
        name.replace('\'', "\\'")
    );
    let response = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", query.as_str()),
            ("spaces", "drive"),
            ("pageSize", "1"),
            ("fields", "files(id)"),
            ("orderBy", "createdTime desc"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to look up Google Drive folder: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google Drive folder lookup failed ({}): {}",
            status, body
        ));
    }

    let body: GoogleDriveListResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Drive folder lookup: {}", e))?;
    Ok(body.files.into_iter().find_map(|file| file.id))
}

async fn ensure_google_drive_root_folder(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<String, String> {
    if let Some(folder_id) =
        find_drive_folder(client, access_token, GOOGLE_DRIVE_ROOT_FOLDER_NAME).await?
    {
        return Ok(folder_id);
    }

    create_drive_folder(
        client,
        access_token,
        None,
        GOOGLE_DRIVE_ROOT_FOLDER_NAME,
    )
    .await
}

async fn ensure_google_access_token(
    app: &AppHandle,
    runtime: &mut BackupGoogleDriveRuntime,
) -> Result<String, String> {
    if let Some(token) = runtime.access_token.clone() {
        if runtime
            .config
            .access_token_expires_at
            .map(|expires_at| expires_at > now_ms() + 60_000)
            .unwrap_or(true)
        {
            return Ok(token);
        }
    }

    let refresh_token = runtime
        .refresh_token
        .clone()
        .ok_or("Google Drive refresh token is missing.")?;
    let client_id = runtime
        .config
        .client_id
        .clone()
        .ok_or("Google Drive client id is missing.")?;
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(client_secret) = get_google_drive_client_secret() {
        form.push(("client_secret", client_secret));
    }

    let response = google_http_client()?
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Google token refresh failed: {}", e))?;

    let status = response.status();
    let body: GoogleTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google token response: {}", e))?;

    if !status.is_success() {
        let missing_secret = body
            .error_description
            .as_deref()
            .or(body.error.as_deref())
            .map(|message| message.contains("client_secret"))
            .unwrap_or(false);
        if missing_secret && get_google_drive_client_secret().is_none() {
            return Err(
                "Google requires a client secret for this OAuth client. Add GOOGLE_DRIVE_CLIENT_SECRET to your app .env or reconnect using a Desktop app OAuth client."
                    .to_string(),
            );
        }
        if body.error.as_deref() == Some("invalid_grant") {
            return Err(
                "Google Drive access has expired or was revoked. Reconnect Google Drive and retry the sync.".to_string(),
            );
        }
        return Err(body
            .error_description
            .or(body.error)
            .unwrap_or_else(|| format!("Google token refresh failed ({})", status)));
    }

    let access_token = body
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or("Google token refresh did not return an access token.")?;
    let expires_at = body
        .expires_in
        .map(|seconds| now_ms() + seconds.saturating_mul(1_000));

    let _ = backup_storage::store_google_access_token(
        app.path().app_data_dir().ok(),
        Some(&access_token),
        expires_at,
    )?;
    runtime.access_token = Some(access_token.clone());
    runtime.config.access_token_expires_at = expires_at;
    Ok(access_token)
}

#[derive(Debug, Deserialize)]
struct GoogleDriveFileResponse {
    id: Option<String>,
}

async fn create_drive_folder(
    client: &reqwest::Client,
    access_token: &str,
    parent_folder_id: Option<&str>,
    name: &str,
) -> Result<String, String> {
    let mut payload = json!({
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    });
    if let Some(parent_folder_id) = parent_folder_id {
        payload["parents"] = json!([parent_folder_id]);
    }
    let response = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to create Google Drive folder: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google Drive folder creation failed ({}): {}",
            status, body
        ));
    }
    let body: GoogleDriveFileResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Drive folder response: {}", e))?;
    body.id
        .ok_or("Google Drive did not return a folder id.".to_string())
}

async fn upload_drive_file_multipart(
    client: &reqwest::Client,
    access_token: &str,
    parent_folder_id: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    let file_name = file_path
        .file_name()
        .and_then(|item| item.to_str())
        .ok_or("Backup artifact file name is invalid.")?
        .to_string();
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("Failed to read backup artifact for upload: {}", e))?;
    let metadata = json!({
        "name": file_name,
        "parents": [parent_folder_id],
    })
    .to_string();

    let form = reqwest::multipart::Form::new()
        .part(
            "metadata",
            reqwest::multipart::Part::text(metadata)
                .mime_str("application/json; charset=UTF-8")
                .map_err(|e| e.to_string())?,
        )
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(
                    file_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                )
                .mime_str(mime_type)
                .map_err(|e| e.to_string())?,
        );

    let response = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(access_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to upload backup artifact to Google Drive: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Google Drive upload failed ({}): {}", status, body));
    }
    let body: GoogleDriveFileResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Drive upload response: {}", e))?;
    body.id
        .ok_or("Google Drive did not return a file id.".to_string())
}

async fn start_resumable_drive_upload(
    client: &reqwest::Client,
    access_token: &str,
    parent_folder_id: &str,
    file_name: &str,
    mime_type: &str,
    file_size: u64,
) -> Result<String, String> {
    let response = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", mime_type)
        .header("X-Upload-Content-Length", file_size.to_string())
        .json(&json!({
            "name": file_name,
            "parents": [parent_folder_id],
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to start Google Drive upload session: {}", e))?;

    let status = response.status();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to start Google Drive upload session ({}): {}",
            status, body
        ));
    }

    location.ok_or("Google Drive did not return an upload session URL.".to_string())
}

async fn upload_drive_file_resumable(
    client: &reqwest::Client,
    access_token: &str,
    parent_folder_id: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    let file_name = file_path
        .file_name()
        .and_then(|item| item.to_str())
        .ok_or("Backup artifact file name is invalid.")?
        .to_string();
    let file_size = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Failed to inspect backup artifact for upload: {}", e))?
        .len();

    if file_size == 0 {
        return upload_drive_file_multipart(
            client,
            access_token,
            parent_folder_id,
            file_path,
            mime_type,
        )
        .await;
    }

    let session_url = start_resumable_drive_upload(
        client,
        access_token,
        parent_folder_id,
        &file_name,
        mime_type,
        file_size,
    )
    .await?;

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open backup artifact for upload: {}", e))?;
    let mut buffer = vec![0u8; GOOGLE_UPLOAD_CHUNK_BYTES];
    let mut start = 0u64;

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read backup artifact for upload: {}", e))?;
        if bytes_read == 0 {
            break;
        }

        let end = start + bytes_read as u64 - 1;
        let response = client
            .put(&session_url)
            .bearer_auth(access_token)
            .header("Content-Length", bytes_read.to_string())
            .header("Content-Type", mime_type)
            .header("Content-Range", format!("bytes {}-{}/{}", start, end, file_size))
            .body(buffer[..bytes_read].to_vec())
            .send()
            .await
            .map_err(|e| format!("Failed to upload backup artifact to Google Drive: {}", e))?;

        if response.status() == reqwest::StatusCode::PERMANENT_REDIRECT {
            start = end + 1;
            continue;
        }

        let status = response.status();
        let body: GoogleDriveFileResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Google Drive upload response: {}", e))?;
        if !status.is_success() {
            return Err(format!("Google Drive upload failed ({})", status));
        }

        return body
            .id
            .ok_or("Google Drive did not return a file id.".to_string());
    }

    Err("Google Drive upload ended before the file finished sending.".to_string())
}

async fn upload_drive_file(
    client: &reqwest::Client,
    access_token: &str,
    parent_folder_id: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    let file_size = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Failed to inspect backup artifact for upload: {}", e))?
        .len();
    if file_size >= GOOGLE_UPLOAD_CHUNK_BYTES as u64 {
        upload_drive_file_resumable(client, access_token, parent_folder_id, file_path, mime_type)
            .await
    } else {
        upload_drive_file_multipart(client, access_token, parent_folder_id, file_path, mime_type)
            .await
    }
}

fn record_from_plan(plan: &BackupExecutionPlan) -> BackupRecord {
    BackupRecord {
        id: plan.backup_id.clone(),
        name: plan.backup_name.clone(),
        scope: plan.scope,
        source_database: plan.source_database.clone(),
        connection_label: plan.connection_label.clone(),
        connection_string: String::new(),
        output_root: plan.output_root.clone(),
        backup_dir: plan.backup_dir.to_string_lossy().to_string(),
        status: BackupRecordStatus::Running,
        started_at: now_ms(),
        completed_at: None,
        bytes_written: 0,
        estimated_bytes: plan.estimated_bytes,
        message: Some("Preparing backup pipeline".to_string()),
        error: None,
        triggered_by: plan.triggered_by.clone(),
        schedule_id: plan.schedule_id.clone(),
        artifacts: Vec::new(),
        server_version: None,
        postgres_client_path: None,
        postgres_client_version: None,
        cloud_sync_status: if plan.sync_to_google_drive {
            Some(BackupCloudSyncStatus::Pending)
        } else {
            Some(BackupCloudSyncStatus::Skipped)
        },
        cloud_sync_message: None,
    }
}

async fn run_backup_plan(
    app: &AppHandle,
    plan: BackupExecutionPlan,
) -> Result<BackupRecord, String> {
    fs::create_dir_all(&plan.backup_dir)
        .map_err(|e| format!("Failed to create backup directory: {}", e))?;

    let tools = detect_pg_clients();
    let mut record = record_from_plan(&plan);
    record.postgres_client_path = tools
        .pg_dump
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    record.postgres_client_version = tools.pg_dump_version.clone();
    backup_storage::upsert_backup(app.path().app_data_dir().ok(), record.clone())?;
    emit_module_changed(app);

    let total_steps = match plan.scope {
        BackupScope::Database => {
            if plan.sync_to_google_drive {
                5
            } else {
                4
            }
        }
        BackupScope::Cluster => {
            let dbs = list_cluster_databases(&tools, &plan.effective_connection_string).await?;
            (dbs.len() as u32) + if plan.sync_to_google_drive { 4 } else { 3 }
        }
    };

    backup_progress(
        app,
        &plan.backup_id,
        "prepare",
        "Preparing a dedicated backup worker and validating PostgreSQL client tools.",
        1,
        total_steps,
        plan.estimated_bytes,
        None,
        None,
    );

    let mut current_step = 1;
    let mut artifacts = Vec::new();
    let mut bytes_written = 0u64;

    match plan.scope {
        BackupScope::Database => {
            let db_name = plan
                .source_database
                .clone()
                .ok_or("Database name is required for database-level backups.")?;
            let archive_path = plan
                .backup_dir
                .join(format!("{}.dump", sanitize_name(&db_name)));
            current_step += 1;
            backup_progress(
                app,
                &plan.backup_id,
                "dump",
                format!(
                    "Streaming {} into a compressed custom backup archive.",
                    db_name
                ),
                current_step,
                total_steps,
                plan.estimated_bytes,
                None,
                Some(db_name.clone()),
            );
            let artifact_size =
                run_pg_dump(&tools, &plan.effective_connection_string, &archive_path).await?;
            bytes_written += artifact_size;
            artifacts.push(BackupArtifact {
                id: uuid::Uuid::new_v4().to_string(),
                label: db_name.clone(),
                kind: "database".to_string(),
                format: "custom".to_string(),
                relative_path: archive_path
                    .strip_prefix(&plan.backup_dir)
                    .unwrap_or(&archive_path)
                    .to_string_lossy()
                    .to_string(),
                absolute_path: archive_path.to_string_lossy().to_string(),
                bytes: artifact_size,
                database_name: Some(db_name),
                google_drive_file_id: None,
            });
        }
        BackupScope::Cluster => {
            let databases =
                list_cluster_databases(&tools, &plan.effective_connection_string).await?;
            let globals_dir = plan.backup_dir.join("globals");
            let db_dir = plan.backup_dir.join("databases");
            fs::create_dir_all(&globals_dir)
                .and_then(|_| fs::create_dir_all(&db_dir))
                .map_err(|e| format!("Failed to prepare cluster backup folders: {}", e))?;

            current_step += 1;
            let globals_path = globals_dir.join("globals.sql.gz");
            backup_progress(
                app,
                &plan.backup_id,
                "globals",
                "Capturing cluster roles and global objects.",
                current_step,
                total_steps,
                plan.estimated_bytes,
                None,
                Some("globals".to_string()),
            );
            let globals_size =
                run_pg_dumpall_globals(&tools, &plan.effective_connection_string, &globals_path)
                    .await?;
            bytes_written += globals_size;
            artifacts.push(BackupArtifact {
                id: uuid::Uuid::new_v4().to_string(),
                label: "Cluster globals".to_string(),
                kind: "globals".to_string(),
                format: "sql_gzip".to_string(),
                relative_path: globals_path
                    .strip_prefix(&plan.backup_dir)
                    .unwrap_or(&globals_path)
                    .to_string_lossy()
                    .to_string(),
                absolute_path: globals_path.to_string_lossy().to_string(),
                bytes: globals_size,
                database_name: None,
                google_drive_file_id: None,
            });

            for db_name in databases {
                current_step += 1;
                let db_archive_path = db_dir.join(format!("{}.dump", sanitize_name(&db_name)));
                backup_progress(
                    app,
                    &plan.backup_id,
                    "dump",
                    format!("Creating a compressed database archive for {}.", db_name),
                    current_step,
                    total_steps,
                    plan.estimated_bytes,
                    Some(bytes_written),
                    Some(db_name.clone()),
                );
                let db_conn = replace_database_in_connection_string(
                    &plan.effective_connection_string,
                    &db_name,
                );
                let db_size = run_pg_dump(&tools, &db_conn, &db_archive_path).await?;
                bytes_written += db_size;
                artifacts.push(BackupArtifact {
                    id: uuid::Uuid::new_v4().to_string(),
                    label: db_name.clone(),
                    kind: "database".to_string(),
                    format: "custom".to_string(),
                    relative_path: db_archive_path
                        .strip_prefix(&plan.backup_dir)
                        .unwrap_or(&db_archive_path)
                        .to_string_lossy()
                        .to_string(),
                    absolute_path: db_archive_path.to_string_lossy().to_string(),
                    bytes: db_size,
                    database_name: Some(db_name),
                    google_drive_file_id: None,
                });
            }
        }
    }

    record.artifacts = artifacts;
    record.bytes_written = bytes_written;
    record.message = Some("Writing backup manifest".to_string());
    write_manifest(&record)?;

    current_step += 1;
    if plan.sync_to_google_drive {
        backup_progress(
            app,
            &plan.backup_id,
            "sync",
            "Uploading the freshly created backup bundle to Google Drive.",
            current_step,
            total_steps,
            plan.estimated_bytes,
            Some(bytes_written),
            None,
        );
        match upload_backup_to_google_drive(app, &mut record).await {
            Ok(()) => {}
            Err(err) => {
                record.cloud_sync_status = Some(BackupCloudSyncStatus::Failed);
                record.cloud_sync_message = Some(err);
            }
        }
    } else {
        backup_progress(
            app,
            &plan.backup_id,
            "sync",
            "Cloud sync skipped. Local backup is ready on disk.",
            current_step,
            total_steps,
            plan.estimated_bytes,
            Some(bytes_written),
            None,
        );
    }

    current_step += 1;
    record.status = BackupRecordStatus::Success;
    record.completed_at = Some(now_ms());
    record.message = Some("Backup completed successfully.".to_string());
    write_manifest(&record)?;
    backup_storage::upsert_backup(app.path().app_data_dir().ok(), record.clone())?;
    backup_progress(
        app,
        &plan.backup_id,
        "complete",
        "Backup completed and history has been updated.",
        current_step,
        total_steps,
        plan.estimated_bytes,
        Some(bytes_written),
        None,
    );
    emit_module_changed(app);
    Ok(record)
}

fn update_schedule_after_run(
    app: &AppHandle,
    schedule_id: &str,
    status: &str,
    last_error: Option<String>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().ok();
    let Some(mut schedule) = backup_storage::find_schedule(app_data_dir.clone(), schedule_id)?
    else {
        return Ok(());
    };
    schedule.last_run_at = Some(now_ms());
    schedule.last_status = Some(status.to_string());
    schedule.last_error = last_error;
    schedule.updated_at = now_ms();
    schedule.next_run_at = if schedule.enabled {
        Some(next_run_after(&schedule.cron, Local::now())?)
    } else {
        None
    };
    let _ = backup_storage::upsert_schedule(app_data_dir, schedule)?;
    emit_module_changed(app);
    Ok(())
}

fn prepare_execution_plan(
    app: &AppHandle,
    request: &BackupRunRequest,
) -> Result<BackupExecutionPlan, String> {
    let backup_id = uuid::Uuid::new_v4().to_string();
    let output_root = normalize_trimmed(request.output_root.clone()).unwrap_or(
        backup_storage::default_output_root(app.path().app_data_dir().ok())?,
    );
    let backup_name = normalize_trimmed(request.name.clone()).unwrap_or_else(|| {
        default_backup_name(
            request.scope,
            &request.connection_label,
            request.source_database.as_deref(),
        )
    });
    let backup_dir = backup_dir_for_plan(&output_root, request.scope, &backup_name, &backup_id);

    let tunnel_id = format!("backup-{}", backup_id);
    let effective_connection_string = maybe_open_ssh_tunnel(
        app,
        &request.connection_string,
        &request.ssh_tunnel,
        &tunnel_id,
    )?
    .unwrap_or_else(|| request.connection_string.clone());

    Ok(BackupExecutionPlan {
        backup_id,
        backup_name,
        scope: request.scope,
        source_database: normalize_trimmed(request.source_database.clone()),
        connection_label: request.connection_label.clone(),
        effective_connection_string,
        output_root,
        backup_dir,
        sync_to_google_drive: request.sync_to_google_drive,
        estimated_bytes: request.estimated_bytes,
        triggered_by: if request.schedule_id.is_some() {
            "schedule".to_string()
        } else {
            "manual".to_string()
        },
        schedule_id: request.schedule_id.clone(),
    })
}

async fn run_with_optional_tunnel(
    app: &AppHandle,
    request: &BackupRunRequest,
) -> Result<BackupRecord, String> {
    let plan = prepare_execution_plan(app, request)?;
    let tunnel_id = format!("backup-{}", plan.backup_id);
    let result = run_backup_plan(app, plan.clone()).await;
    if request
        .ssh_tunnel
        .as_ref()
        .map(|config| config.use_ssh_tunneling)
        .unwrap_or(false)
    {
        close_ssh_tunnel(app, &tunnel_id);
    }
    result
}

#[derive(Debug, Clone)]
struct CronField {
    any: bool,
    values: BTreeSet<u32>,
}

fn parse_cron_value(raw: &str, min: u32, max: u32, is_dow: bool) -> Result<u32, String> {
    let parsed = raw
        .parse::<u32>()
        .map_err(|_| format!("Invalid cron value `{}`", raw))?;
    let normalized = if is_dow && parsed == 7 { 0 } else { parsed };
    if normalized < min || normalized > max {
        return Err(format!("Cron value `{}` is outside {}-{}", raw, min, max));
    }
    Ok(normalized)
}

fn parse_cron_field(raw: &str, min: u32, max: u32, is_dow: bool) -> Result<CronField, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Empty cron field".to_string());
    }
    let mut values = BTreeSet::new();
    for part in trimmed.split(',') {
        let (base, step) = match part.split_once('/') {
            Some((lhs, rhs)) => {
                let parsed_step = rhs
                    .trim()
                    .parse::<u32>()
                    .map_err(|_| format!("Invalid cron step `{}`", rhs))?;
                if parsed_step == 0 {
                    return Err("Cron step must be greater than zero".to_string());
                }
                (lhs.trim(), parsed_step)
            }
            None => (part.trim(), 1),
        };

        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((lhs, rhs)) = base.split_once('-') {
            (
                parse_cron_value(lhs.trim(), min, max, is_dow)?,
                parse_cron_value(rhs.trim(), min, max, is_dow)?,
            )
        } else {
            let single = parse_cron_value(base, min, max, is_dow)?;
            if step == 1 {
                (single, single)
            } else {
                (single, max)
            }
        };

        if start > end {
            return Err(format!("Invalid cron range `{}`", part));
        }
        for value in (start..=end).step_by(step as usize) {
            values.insert(if is_dow && value == 7 { 0 } else { value });
        }
    }

    Ok(CronField {
        any: trimmed == "*",
        values,
    })
}

fn parse_cron_expression(cron: &str) -> Result<[CronField; 5], String> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(
            "Cron must contain exactly 5 fields: minute hour day-of-month month day-of-week"
                .to_string(),
        );
    }
    Ok([
        parse_cron_field(parts[0], 0, 59, false)?,
        parse_cron_field(parts[1], 0, 23, false)?,
        parse_cron_field(parts[2], 1, 31, false)?,
        parse_cron_field(parts[3], 1, 12, false)?,
        parse_cron_field(parts[4], 0, 6, true)?,
    ])
}

fn cron_matches(fields: &[CronField; 5], dt: chrono::DateTime<Local>) -> bool {
    let minute_match = fields[0].values.contains(&dt.minute());
    let hour_match = fields[1].values.contains(&dt.hour());
    let dom_match = fields[2].values.contains(&dt.day());
    let month_match = fields[3].values.contains(&dt.month());
    let dow = dt.weekday().num_days_from_sunday();
    let dow_match = fields[4].values.contains(&dow);

    let day_match = if fields[2].any && fields[4].any {
        true
    } else if fields[2].any {
        dow_match
    } else if fields[4].any {
        dom_match
    } else {
        dom_match || dow_match
    };

    minute_match && hour_match && month_match && day_match
}

fn next_run_after(cron: &str, after: chrono::DateTime<Local>) -> Result<i64, String> {
    let fields = parse_cron_expression(cron)?;
    let mut candidate = after + chrono::Duration::minutes(1);
    candidate = candidate
        .with_second(0)
        .and_then(|dt| dt.with_nanosecond(0))
        .unwrap_or(candidate);
    for _ in 0..(366 * 24 * 60) {
        if cron_matches(&fields, candidate) {
            return Ok(candidate.timestamp_millis());
        }
        candidate += chrono::Duration::minutes(1);
    }
    Err("Cron expression did not produce a run time within the next 12 months.".to_string())
}

async fn run_due_schedule(app: AppHandle, schedule: BackupSchedule) {
    let request = BackupRunRequest {
        connection_id: None,
        connection_label: schedule.connection_label.clone(),
        connection_string: schedule.connection_string.clone(),
        ssh_tunnel: schedule.ssh_tunnel.clone(),
        scope: schedule.scope,
        source_database: schedule.source_database.clone(),
        output_root: Some(schedule.output_root.clone()),
        sync_to_google_drive: schedule.sync_to_google_drive,
        name: Some(schedule.name.clone()),
        schedule_id: Some(schedule.id.clone()),
        estimated_bytes: None,
    };

    let result = run_with_optional_tunnel(&app, &request).await;
    match result {
        Ok(record) => {
            let mut last_error = None;
            if matches!(
                record.cloud_sync_status,
                Some(BackupCloudSyncStatus::Failed)
            ) {
                last_error = record.cloud_sync_message.clone();
            }
            let _ = update_schedule_after_run(&app, &schedule.id, "success", last_error);
        }
        Err(err) => {
            let _ = update_schedule_after_run(&app, &schedule.id, "failed", Some(err));
        }
    }
    RUNNING_SCHEDULES.remove(&schedule.id);
}

async fn poll_due_schedules(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().ok();
    let state = backup_storage::load_state(app_data_dir)?;
    let now = now_ms();
    for schedule in state.schedules {
        if !schedule.enabled {
            continue;
        }
        let Some(next_run_at) = schedule.next_run_at else {
            continue;
        };
        if next_run_at > now {
            continue;
        }
        if !RUNNING_SCHEDULES.insert(schedule.id.clone()) {
            continue;
        }
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            run_due_schedule(app_clone, schedule).await;
        });
    }
    Ok(())
}

pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = poll_due_schedules(app.clone()).await {
                log::warn!("[backup-scheduler] {err}");
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(45)).await;
        }
    });
}

#[tauri::command]
pub async fn backup_get_module_state(app: AppHandle) -> Result<BackupModuleState, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = backup_storage::load_state(Some(app_data_dir.clone()))?;
    Ok(BackupModuleState {
        backups: file.backups,
        schedules: file.schedules,
        default_output_root: backup_storage::default_output_root(Some(app_data_dir.clone()))?,
        google_drive: backup_storage::google_drive_status(Some(app_data_dir))?,
        capabilities: backup_capabilities(),
    })
}

#[tauri::command]
pub async fn backup_estimate_size(
    state: State<'_, AppState>,
    connection_id: String,
    scope: BackupScope,
) -> Result<BackupSizeEstimate, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| format!("Failed to connect for backup size estimation: {}", e))?;

    match scope {
        BackupScope::Database => {
            let row = client
                .query_one(
                    "SELECT current_database()::text, pg_database_size(current_database())::bigint",
                    &[],
                )
                .await
                .map_err(|e| format!("Failed to estimate current database size: {}", e))?;
            let db_name: String = row.get(0);
            let estimated: i64 = row.get(1);
            Ok(BackupSizeEstimate {
                scope,
                estimated_bytes: estimated.max(0) as u64,
                database_breakdown: vec![BackupSizeEstimateItem {
                    database_name: db_name,
                    estimated_bytes: estimated.max(0) as u64,
                }],
            })
        }
        BackupScope::Cluster => {
            let rows = client
                .query(
                    "SELECT datname::text, pg_database_size(datname)::bigint
                     FROM pg_database
                     WHERE datallowconn AND NOT datistemplate
                     ORDER BY datname",
                    &[],
                )
                .await
                .map_err(|e| format!("Failed to estimate cluster size: {}", e))?;
            let mut total = 0u64;
            let mut items = Vec::with_capacity(rows.len());
            for row in rows {
                let db_name: String = row.get(0);
                let estimated: i64 = row.get(1);
                let bytes = estimated.max(0) as u64;
                total = total.saturating_add(bytes);
                items.push(BackupSizeEstimateItem {
                    database_name: db_name,
                    estimated_bytes: bytes,
                });
            }
            Ok(BackupSizeEstimate {
                scope,
                estimated_bytes: total,
                database_breakdown: items,
            })
        }
    }
}

#[tauri::command]
pub async fn backup_run_now(
    app: AppHandle,
    request: BackupRunRequest,
) -> Result<BackupRecord, String> {
    let plan = prepare_execution_plan(&app, &request)?;
    let tunnel_id = format!("backup-{}", plan.backup_id);
    let result = run_backup_plan(&app, plan.clone()).await;

    if request
        .ssh_tunnel
        .as_ref()
        .map(|config| config.use_ssh_tunneling)
        .unwrap_or(false)
    {
        close_ssh_tunnel(&app, &tunnel_id);
    }

    match result {
        Ok(record) => Ok(record),
        Err(err) => {
            let mut failed_record = record_from_plan(&plan);
            failed_record.status = BackupRecordStatus::Failed;
            failed_record.error = Some(err.clone());
            failed_record.message = Some("Backup failed before completion.".to_string());
            failed_record.completed_at = Some(now_ms());
            if plan.sync_to_google_drive {
                failed_record.cloud_sync_status = Some(BackupCloudSyncStatus::Skipped);
            }
            let _ = backup_storage::upsert_backup(app.path().app_data_dir().ok(), failed_record);
            emit_module_changed(&app);
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    request: BackupRestoreRequest,
) -> Result<BackupRestoreResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let record = backup_storage::find_backup(Some(app_data_dir), &request.backup_id)?
        .ok_or("Selected backup could not be found.")?;

    let source_database = normalize_trimmed(request.source_database.clone())
        .or_else(|| record.source_database.clone());
    let artifact = match record.scope {
        BackupScope::Database => record
            .artifacts
            .iter()
            .find(|item| item.kind == "database")
            .cloned(),
        BackupScope::Cluster => {
            let source = source_database
                .clone()
                .ok_or("Pick which database inside this cluster backup should be restored.")?;
            record
                .artifacts
                .iter()
                .find(|item| item.database_name.as_deref() == Some(source.as_str()))
                .cloned()
        }
    }
    .ok_or("The selected backup artifact is no longer available.")?;

    let tools = detect_pg_clients();
    let restore_job_id = format!("restore-{}", uuid::Uuid::new_v4());
    let tunnel_id = format!("restore-tunnel-{}", restore_job_id);
    let effective_connection_string = maybe_open_ssh_tunnel(
        &app,
        &request.connection_string,
        &request.ssh_tunnel,
        &tunnel_id,
    )?
    .unwrap_or_else(|| request.connection_string.clone());
    let target_connection_string = replace_database_in_connection_string(
        &effective_connection_string,
        &request.target_database,
    );

    restore_progress(
        &app,
        &restore_job_id,
        "validate",
        "Validating the selected backup artifact before restore.",
        1,
        4,
        Some(artifact.label.clone()),
    );

    if !Path::new(&artifact.absolute_path).exists() {
        close_ssh_tunnel(&app, &tunnel_id);
        return Err("The backup file is missing from disk. Delete the stale entry or pick a different backup.".to_string());
    }

    if request.create_database_if_missing {
        restore_progress(
            &app,
            &restore_job_id,
            "prepare",
            format!(
                "Ensuring {} exists before restore.",
                request.target_database
            ),
            2,
            4,
            Some(request.target_database.clone()),
        );
        ensure_database_exists(
            &tools,
            &effective_connection_string,
            &request.target_database,
        )
        .await?;
    }

    restore_progress(
        &app,
        &restore_job_id,
        "restore",
        format!(
            "Restoring {} into {}.",
            artifact.label, request.target_database
        ),
        3,
        4,
        Some(artifact.label.clone()),
    );
    let restore_result = run_pg_restore_custom(
        &tools,
        &target_connection_string,
        Path::new(&artifact.absolute_path),
        request.clean_restore,
    )
    .await;

    close_ssh_tunnel(&app, &tunnel_id);
    restore_result?;

    restore_progress(
        &app,
        &restore_job_id,
        "complete",
        "Restore completed successfully.",
        4,
        4,
        Some(artifact.label.clone()),
    );

    Ok(BackupRestoreResult {
        backup_id: request.backup_id,
        target_database: request.target_database,
        restored_artifact: artifact.label,
        message: "Restore completed successfully.".to_string(),
    })
}

#[tauri::command]
pub async fn backup_upsert_schedule(
    app: AppHandle,
    input: BackupScheduleInput,
) -> Result<Vec<BackupSchedule>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let existing = if let Some(id) = &input.id {
        backup_storage::find_schedule(Some(app_data_dir.clone()), id)?
    } else {
        None
    };

    let cron = input.cron.trim().to_string();
    let next_run_at = if input.enabled {
        Some(next_run_after(&cron, Local::now())?)
    } else {
        None
    };
    let now = now_ms();
    let schedule = BackupSchedule {
        id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: input.name.trim().to_string(),
        enabled: input.enabled,
        cron,
        scope: input.scope,
        source_database: normalize_trimmed(input.source_database),
        connection_label: input.connection_label.trim().to_string(),
        connection_string: input.connection_string.trim().to_string(),
        output_root: normalize_trimmed(input.output_root).unwrap_or(
            backup_storage::default_output_root(Some(app_data_dir.clone()))?,
        ),
        sync_to_google_drive: input.sync_to_google_drive,
        ssh_tunnel: input.ssh_tunnel,
        created_at: existing.as_ref().map(|item| item.created_at).unwrap_or(now),
        updated_at: now,
        next_run_at,
        last_run_at: existing.as_ref().and_then(|item| item.last_run_at),
        last_status: existing.as_ref().and_then(|item| item.last_status.clone()),
        last_error: existing.as_ref().and_then(|item| item.last_error.clone()),
    };

    let schedules = backup_storage::upsert_schedule(Some(app_data_dir), schedule)?;
    emit_module_changed(&app);
    Ok(schedules)
}

#[tauri::command]
pub async fn backup_delete_schedule(
    app: AppHandle,
    id: String,
) -> Result<Vec<BackupSchedule>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let schedules = backup_storage::delete_schedule(Some(app_data_dir), &id)?;
    RUNNING_SCHEDULES.remove(&id);
    emit_module_changed(&app);
    Ok(schedules)
}

#[tauri::command]
pub async fn backup_delete_record(
    app: AppHandle,
    id: String,
    delete_files: bool,
) -> Result<Vec<BackupRecord>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if delete_files {
        if let Some(record) = backup_storage::find_backup(Some(app_data_dir.clone()), &id)? {
            let path = PathBuf::from(record.backup_dir);
            if path.exists() {
                fs::remove_dir_all(&path)
                    .map_err(|e| format!("Failed to delete backup files: {}", e))?;
            }
        }
    }
    let records = backup_storage::delete_backup(Some(app_data_dir), &id)?;
    emit_module_changed(&app);
    Ok(records)
}

async fn revoke_google_token(token: &str) -> Result<(), String> {
    let response = google_http_client()?
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token.to_string())])
        .send()
        .await
        .map_err(|e| format!("Failed to revoke Google Drive token: {}", e))?;

    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Failed to revoke Google Drive token ({}): {}",
        status, body
    ))
}

#[tauri::command]
pub async fn backup_connect_google_drive(
    app: AppHandle,
) -> Result<BackupGoogleDriveStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let client_id = get_google_drive_client_id()?;
    let existing_runtime = backup_storage::load_google_drive_runtime(Some(app_data_dir.clone()))?;
    let existing_refresh_token = existing_runtime
        .as_ref()
        .and_then(|runtime| runtime.refresh_token.clone());
    let existing_connected_email = existing_runtime
        .as_ref()
        .and_then(|runtime| runtime.config.connected_email.clone());

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to start Google Drive callback listener: {}", e))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to inspect Google Drive callback listener: {}", e))?;
    let redirect_uri = format!("http://127.0.0.1:{}", local_addr.port());
    let state = uuid::Uuid::new_v4().to_string();
    let (code_verifier, code_challenge) = build_google_pkce_pair();
    let auth_url = build_google_oauth_url(&client_id, &redirect_uri, &state, &code_challenge)?;

    opener::open_browser(&auth_url).map_err(|e| format!("Failed to open browser: {}", e))?;

    let mut callback = wait_for_google_oauth_callback(listener, &state).await?;

    let result = async {
        let token_response =
            exchange_google_oauth_code(&client_id, &redirect_uri, &callback.code, &code_verifier)
                .await?;
        let granted_scope = token_response.scope.clone().unwrap_or_default();
        if !granted_scope
            .split_whitespace()
            .any(|scope| scope == GOOGLE_DRIVE_SCOPE)
        {
            return Err(
                "Google Drive access was not granted. Make sure the Drive permission stays enabled when you connect."
                    .to_string(),
            );
        }

        let access_token = token_response
            .access_token
            .filter(|value| !value.trim().is_empty())
            .ok_or("Google token exchange did not return an access token.")?;
        let refresh_token = token_response
            .refresh_token
            .filter(|value| !value.trim().is_empty())
            .or(existing_refresh_token)
            .filter(|value| !value.trim().is_empty());
        let expires_at = token_response
            .expires_in
            .map(|seconds| now_ms() + seconds.saturating_mul(1_000));

        let client = google_http_client()?;
        let user_info = fetch_google_user_info(&client, &access_token).await?;
        let drive_user = fetch_google_drive_user(&client, &access_token).await?;
        let connected_email = user_info
            .and_then(|user| user.email.or(user.name))
            .or_else(|| drive_user.and_then(|user| user.email_address.or(user.display_name)))
            .or(existing_connected_email)
            .filter(|value| !value.trim().is_empty());
        let folder_id = ensure_google_drive_root_folder(&client, &access_token).await?;

        let status = backup_storage::save_google_drive_config(
            Some(app_data_dir),
            BackupGoogleDriveConfigInput {
                enabled: true,
                folder_id: Some(folder_id.clone()),
                client_id: Some(client_id),
                refresh_token,
                access_token: Some(access_token),
                connected_email,
                connected_at: Some(now_ms()),
                access_token_expires_at: expires_at,
            },
        )?;
        log::info!(
            "[backup] Google Drive connected. Folder: {}",
            google_drive_folder_url(&folder_id)
        );
        Ok((status, folder_id))
    }
    .await;

    match result {
        Ok((status, folder_id)) => {
            reply_google_oauth_page(
                &mut callback.stream,
                "Google Drive Connected",
                "HelixDB finished the connection and your backup folder is ready. You can close this tab and return to the app.",
            )
            .await;
            log::info!(
                "[backup] Google Drive connection completed successfully for folder {}",
                folder_id
            );
            emit_module_changed(&app);
            Ok(status)
        }
        Err(err) => {
            reply_google_oauth_page(
                &mut callback.stream,
                "Google Drive Connection Failed",
                &err,
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn backup_save_google_drive_config(
    app: AppHandle,
    input: BackupGoogleDriveConfigInput,
) -> Result<BackupGoogleDriveStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let status = backup_storage::save_google_drive_config(Some(app_data_dir), input)?;
    emit_module_changed(&app);
    Ok(status)
}

#[tauri::command]
pub async fn backup_clear_google_drive_config(
    app: AppHandle,
) -> Result<BackupGoogleDriveStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(runtime) = backup_storage::load_google_drive_runtime(Some(app_data_dir.clone()))? {
        let token = runtime
            .refresh_token
            .as_deref()
            .or(runtime.access_token.as_deref());
        if let Some(token) = token {
            if let Err(err) = revoke_google_token(token).await {
                log::warn!("[backup] Failed to revoke Google Drive token during disconnect: {err}");
            }
        }
    }
    let status = backup_storage::clear_google_drive_config(Some(app_data_dir))?;
    emit_module_changed(&app);
    Ok(status)
}
