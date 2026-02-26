use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command as StdCommand;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalPostgresStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub data_dir: Option<String>,
    pub port: u16,
    pub host: String,
    pub connection_string: Option<String>,
    pub install_method: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    pub percent: u32,
    pub message: String,
    pub log: Option<String>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn run_cmd_raw(program: &str, args: &[&str]) -> Option<(bool, String, String)> {
    StdCommand::new(program).args(args).output().ok().map(|o| {
        (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        )
    })
}

fn run_cmd(program: &str, args: &[&str]) -> Option<String> {
    run_cmd_raw(program, args)
        .filter(|(ok, _, _)| *ok)
        .map(|(_, stdout, _)| stdout)
}

fn which(binary: &str) -> Option<String> {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";

    run_cmd(finder, &[binary])
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
}

fn find_psql() -> Option<String> {
    if let Some(p) = which("psql") {
        return Some(p);
    }
    let paths = [
        "/opt/homebrew/bin/psql",
        "/usr/local/bin/psql",
        "/usr/bin/psql",
        "/usr/lib/postgresql/17/bin/psql",
        "/usr/lib/postgresql/16/bin/psql",
        "/usr/lib/postgresql/15/bin/psql",
        "/usr/lib/postgresql/14/bin/psql",
        r"C:\Program Files\PostgreSQL\17\bin\psql.exe",
        r"C:\Program Files\PostgreSQL\16\bin\psql.exe",
        r"C:\Program Files\PostgreSQL\15\bin\psql.exe",
    ];
    paths
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| s.to_string())
}

fn get_pg_version(psql: &str) -> Option<String> {
    run_cmd(psql, &["--version"])
}

fn is_running() -> bool {
    // pg_isready is definitive
    if let Some(path) = which("pg_isready") {
        if let Some((ok, out, _)) = run_cmd_raw(&path, &["-h", "localhost", "-p", "5432"]) {
            if ok || out.contains("accepting connections") {
                return true;
            }
        }
    }
    // Fallback: TCP probe
    use std::net::TcpStream;
    use std::time::Duration;
    if let Ok(addr) = "127.0.0.1:5432".parse() {
        return TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok();
    }
    false
}

fn find_brew() -> Option<String> {
    for p in &["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    which("brew")
}

/// Returns (brew_path, service_name) for the installed postgresql formula.
fn find_brew_pg_service() -> Option<(String, String)> {
    let brew = find_brew()?;
    let list = run_cmd(&brew, &["list", "--formula"])?;
    // Prefer postgresql@16, then postgresql@15, etc., then plain postgresql
    let mut found: Option<String> = None;
    for line in list.lines() {
        let t = line.trim();
        if t.starts_with("postgresql") {
            found = Some(t.to_string());
            // Keep the first match; could be postgresql@16 etc.
            break;
        }
    }
    found.map(|svc| (brew, svc))
}

fn detect_install_method() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if find_brew().is_some() {
            return Some("brew".to_string());
        }
        return Some("system".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        if which("apt-get").is_some() {
            return Some("apt".to_string());
        }
        if which("dnf").is_some() {
            return Some("dnf".to_string());
        }
        if which("yum").is_some() {
            return Some("yum".to_string());
        }
        if which("pacman").is_some() {
            return Some("pacman".to_string());
        }
        return Some("system".to_string());
    }
    #[cfg(windows)]
    {
        return Some("windows".to_string());
    }
    #[allow(unreachable_code)]
    Some("unknown".to_string())
}

fn find_data_dir() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(brew) = find_brew() {
            if let Some(prefix) = run_cmd(&brew, &["--prefix"]) {
                for ver in &["@16", "@17", "@15", "@14", ""] {
                    let dir = if ver.is_empty() {
                        format!("{}/var/postgresql", prefix)
                    } else {
                        format!("{}/var/postgresql{}", prefix, ver)
                    };
                    if Path::new(&dir).exists() {
                        return Some(dir);
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for dir in &[
            "/var/lib/postgresql/17/main",
            "/var/lib/postgresql/16/main",
            "/var/lib/postgresql/15/main",
            "/var/lib/postgresql/14/main",
            "/var/lib/pgsql/data",
        ] {
            if Path::new(dir).exists() {
                return Some(dir.to_string());
            }
        }
    }
    None
}

// ── Public API ─────────────────────────────────────────────────────────────

pub async fn check_local_postgres() -> LocalPostgresStatus {
    let psql = find_psql();
    let installed = psql.is_some();
    let running = is_running();
    let version = psql.as_ref().and_then(|p| get_pg_version(p));
    let install_method = detect_install_method();
    let data_dir = find_data_dir();

    LocalPostgresStatus {
        installed,
        running,
        version,
        data_dir,
        port: 5432,
        host: "localhost".to_string(),
        connection_string: if running {
            Some("postgresql://localhost:5432/postgres".to_string())
        } else {
            None
        },
        install_method,
    }
}

pub async fn start_local_postgres() -> Result<LocalPostgresStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some((brew, svc)) = find_brew_pg_service() {
            run_cmd(&brew, &["services", "start", &svc]);
        } else if let Some(data_dir) = find_data_dir() {
            run_cmd("pg_ctl", &["-D", &data_dir, "start"]);
        } else {
            return Err("Cannot determine how to start PostgreSQL".to_string());
        }
    }
    #[cfg(target_os = "linux")]
    {
        run_cmd("sudo", &["systemctl", "start", "postgresql"]);
    }
    #[cfg(windows)]
    {
        for ver in &["17", "16", "15", "14"] {
            let svc = format!("postgresql-x64-{}", ver);
            if run_cmd("net", &["start", &svc]).is_some() {
                break;
            }
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    Ok(check_local_postgres().await)
}

pub async fn stop_local_postgres() -> Result<LocalPostgresStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some((brew, svc)) = find_brew_pg_service() {
            run_cmd(&brew, &["services", "stop", &svc]);
        } else if let Some(data_dir) = find_data_dir() {
            run_cmd("pg_ctl", &["-D", &data_dir, "stop"]);
        } else {
            return Err("Cannot determine how to stop PostgreSQL".to_string());
        }
    }
    #[cfg(target_os = "linux")]
    {
        run_cmd("sudo", &["systemctl", "stop", "postgresql"]);
    }
    #[cfg(windows)]
    {
        for ver in &["17", "16", "15", "14"] {
            let svc = format!("postgresql-x64-{}", ver);
            if run_cmd("net", &["stop", &svc]).is_some() {
                break;
            }
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    Ok(check_local_postgres().await)
}

pub async fn restart_local_postgres() -> Result<LocalPostgresStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some((brew, svc)) = find_brew_pg_service() {
            run_cmd(&brew, &["services", "restart", &svc]);
        } else if let Some(data_dir) = find_data_dir() {
            run_cmd("pg_ctl", &["-D", &data_dir, "restart"]);
        } else {
            return Err("Cannot determine how to restart PostgreSQL".to_string());
        }
    }
    #[cfg(target_os = "linux")]
    {
        run_cmd("sudo", &["systemctl", "restart", "postgresql"]);
    }
    #[cfg(windows)]
    {
        stop_local_postgres().await.ok();
        start_local_postgres().await.ok();
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    Ok(check_local_postgres().await)
}

pub async fn install_local_postgres(app: &tauri::AppHandle) -> Result<LocalPostgresStatus, String> {
    let emit = |percent: u32, message: &str, log: Option<String>| {
        let _ = app.emit(
            "local-postgres-install-progress",
            InstallProgress {
                percent,
                message: message.to_string(),
                log,
            },
        );
    };

    #[cfg(target_os = "macos")]
    {
        let brew = find_brew().ok_or_else(|| {
            "Homebrew is not installed. Install it first from https://brew.sh".to_string()
        })?;

        emit(5, "Checking Homebrew...", None);
        let _ = StdCommand::new(&brew).arg("update").output();

        emit(15, "Installing PostgreSQL 16...", None);
        let out = StdCommand::new(&brew)
            .args(["install", "postgresql@16"])
            .output()
            .map_err(|e| format!("brew install failed: {e}"))?;

        let log_text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.contains("already installed") {
                let last_line = stderr.lines().last().unwrap_or("Unknown error").to_string();
                return Err(format!("Installation failed: {last_line}"));
            }
        }

        emit(70, "Configuring PostgreSQL...", Some(log_text));
        emit(80, "Starting PostgreSQL service...", None);

        let start_out = StdCommand::new(&brew)
            .args(["services", "start", "postgresql@16"])
            .output()
            .map_err(|e| format!("Failed to start service: {e}"))?;

        let start_log = String::from_utf8_lossy(&start_out.stdout).to_string();
        emit(90, "Waiting for PostgreSQL to be ready...", Some(start_log));

        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        emit(100, "PostgreSQL is ready!", None);

        return Ok(check_local_postgres().await);
    }

    #[cfg(target_os = "linux")]
    {
        if which("apt-get").is_some() {
            emit(5, "Updating package lists...", None);
            let _ = StdCommand::new("sudo")
                .args(["apt-get", "update", "-qq"])
                .output();

            emit(30, "Installing PostgreSQL...", None);
            let out = StdCommand::new("sudo")
                .args([
                    "apt-get",
                    "install",
                    "-y",
                    "postgresql",
                    "postgresql-contrib",
                ])
                .output()
                .map_err(|e| format!("apt install failed: {e}"))?;

            if !out.status.success() {
                return Err(format!(
                    "Installation failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }

            emit(75, "Starting PostgreSQL service...", None);
            let _ = StdCommand::new("sudo")
                .args(["systemctl", "start", "postgresql"])
                .output();
            let _ = StdCommand::new("sudo")
                .args(["systemctl", "enable", "postgresql"])
                .output();

            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            emit(100, "PostgreSQL is ready!", None);
            return Ok(check_local_postgres().await);
        }

        if which("dnf").is_some() {
            emit(5, "Installing PostgreSQL via dnf...", None);
            let out = StdCommand::new("sudo")
                .args([
                    "dnf",
                    "install",
                    "-y",
                    "postgresql-server",
                    "postgresql-contrib",
                ])
                .output()
                .map_err(|e| format!("dnf install failed: {e}"))?;

            if !out.status.success() {
                return Err(format!(
                    "Installation failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }

            emit(70, "Initializing database cluster...", None);
            let _ = StdCommand::new("sudo")
                .args(["postgresql-setup", "--initdb"])
                .output();

            emit(80, "Starting PostgreSQL service...", None);
            let _ = StdCommand::new("sudo")
                .args(["systemctl", "start", "postgresql"])
                .output();
            let _ = StdCommand::new("sudo")
                .args(["systemctl", "enable", "postgresql"])
                .output();

            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            emit(100, "PostgreSQL is ready!", None);
            return Ok(check_local_postgres().await);
        }

        return Err(
            "No supported package manager (apt/dnf) found. Please install PostgreSQL manually."
                .to_string(),
        );
    }

    #[cfg(windows)]
    {
        return Err(
            "Automatic installation on Windows is not supported. Download PostgreSQL from https://www.postgresql.org/download/windows/"
                .to_string(),
        );
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}
