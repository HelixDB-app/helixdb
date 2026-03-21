//! SSH tunnel manager: spawns `ssh -L local_port:db_host:db_port` and keeps the process
//! until disconnect. Do not log ssh_password.

use crate::connections_storage::SshTunnelConfig;
use dashmap::DashMap;
use std::process::{Child, Command, Stdio};

pub struct SshTunnelManager {
    /// connection_id -> (local_port, child process)
    processes: DashMap<String, (u16, Child)>,
}

impl SshTunnelManager {
    pub fn new() -> Self {
        Self {
            processes: DashMap::new(),
        }
    }

    /// Pick an available local port.
    fn pick_local_port() -> Result<u16, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to bind for tunnel port: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();
        drop(listener);
        Ok(port)
    }

    /// Start an SSH tunnel. Returns the local port to connect to.
    /// Caller must build a new connection string with host=127.0.0.1 and port=returned_port.
    pub fn start(
        &self,
        connection_id: &str,
        config: &SshTunnelConfig,
        db_host: &str,
        db_port: u16,
    ) -> Result<u16, String> {
        if config.tunnel_host.is_empty() {
            return Err("SSH tunnel host is required".to_string());
        }
        if config.username.is_empty() {
            return Err("SSH tunnel username is required".to_string());
        }

        let local_port = Self::pick_local_port()?;
        let keep_alive = config.keep_alive_seconds.unwrap_or(0);
        let tunnel_port = config.tunnel_port;

        let mut ssh_args = vec![
            "-L".to_string(),
            format!("127.0.0.1:{}:{}:{}", local_port, db_host, db_port),
            "-N".to_string(),
            "-o".to_string(),
            "StrictHostKeyChecking=accept-new".to_string(),
        ];
        if keep_alive > 0 {
            ssh_args.push("-o".to_string());
            ssh_args.push(format!("ServerAliveInterval={}", keep_alive));
        }
        ssh_args.push("-p".to_string());
        ssh_args.push(tunnel_port.to_string());
        ssh_args.push(format!("{}@{}", config.username, config.tunnel_host));

        let child = if config.authentication == "identity_file" {
            let identity = config
                .identity_file_path
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or("Identity file path is required when using identity file authentication")?;
            ssh_args.push("-i".to_string());
            ssh_args.push(identity.to_string());
            Command::new("ssh")
                .args(&ssh_args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start ssh: {}. Is ssh installed?", e))?
        } else {
            // Password auth: use sshpass if available
            let password = config.ssh_password.as_deref().unwrap_or("");
            if password.is_empty() {
                return Err("SSH password is required for password authentication".to_string());
            }
            Command::new("sshpass")
                .args(["-p", password, "ssh"])
                .args(&ssh_args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| {
                    format!(
                        "Failed to start sshpass/ssh: {}. For password auth, install sshpass (e.g. brew install sshpass) or use identity file.",
                        e
                    )
                })?
        };

        self.processes
            .insert(connection_id.to_string(), (local_port, child));
        Ok(local_port)
    }

    /// Stop the tunnel for this connection (kill the SSH process).
    pub fn stop(&self, connection_id: &str) -> bool {
        if let Some((_, (_, mut child))) = self.processes.remove(connection_id) {
            let _ = child.kill();
            true
        } else {
            false
        }
    }
}

impl Default for SshTunnelManager {
    fn default() -> Self {
        Self::new()
    }
}
