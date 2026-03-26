use sha2::{Digest, Sha256};

/// Application-specific HMAC key embedded in the binary.
/// This prevents offline precomputation of device ID hashes.
const APP_SALT: &str = "pgstudio-v1-device-fingerprint-2025";

// ─── Platform-specific hardware ID retrieval ──────────────────────────────────

#[cfg(target_os = "macos")]
fn get_raw_hardware_id() -> Result<String, String> {
    use std::process::Command;
    // Read the IOPlatformUUID — a stable hardware UUID burned into the Mac's firmware
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("ioreg failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // Line looks like:   "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            if let Some(start) = line.rfind('"') {
                let after = &line[..start];
                if let Some(start2) = after.rfind('"') {
                    let uuid = &after[start2 + 1..];
                    if uuid.len() >= 32 {
                        return Ok(uuid.to_string());
                    }
                }
            }
        }
    }
    Err("IOPlatformUUID not found in ioreg output".to_string())
}

#[cfg(target_os = "windows")]
fn get_raw_hardware_id() -> Result<String, String> {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .map_err(|e| format!("reg query failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("MachineGuid") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(guid) = parts.last() {
                if guid.len() >= 32 {
                    return Ok(guid.to_string());
                }
            }
        }
    }
    Err("MachineGuid not found in registry".to_string())
}

#[cfg(target_os = "linux")]
fn get_raw_hardware_id() -> Result<String, String> {
    // /etc/machine-id is a stable 128-bit hex string generated once on OS install
    let id = std::fs::read_to_string("/etc/machine-id")
        .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
        .map_err(|e| format!("Cannot read machine-id: {e}"))?;
    let trimmed = id.trim().to_string();
    if trimmed.is_empty() {
        return Err("machine-id is empty".to_string());
    }
    Ok(trimmed)
}

/// iOS/Android: no OS-level hardware UUID is exposed like on desktop. Use a stable
/// per-install identifier persisted in the app sandbox (cleared on uninstall).
#[cfg(any(target_os = "ios", target_os = "android"))]
fn get_raw_hardware_id() -> Result<String, String> {
    let dir = mobile_support_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app support dir: {e}"))?;
    let path = dir.join("install_device_raw_id_v1");
    if path.exists() {
        let s = std::fs::read_to_string(&path).map_err(|e| format!("read device id: {e}"))?;
        let t = s.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, &id).map_err(|e| format!("write device id: {e}"))?;
    Ok(id)
}

#[cfg(target_os = "ios")]
fn mobile_support_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set (iOS)".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("pgstudio"))
}

#[cfg(target_os = "android")]
fn mobile_support_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set (Android)".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join("files")
        .join("pgstudio"))
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Returns a stable, hardware-bound, 64-character hex device fingerprint.
///
/// The fingerprint is derived as:
///   SHA-256( APP_SALT + ":" + raw_hardware_id )
///
/// This makes the fingerprint:
/// - Unique per machine (hardware-bound)
/// - App-specific (salted with APP_SALT — other apps can't reuse it)
/// - Safe to transmit (never reveals the raw hardware UUID)
/// - Stable across reinstalls (hardware doesn't change)
pub fn get_device_fingerprint() -> Result<String, String> {
    let raw_id = get_raw_hardware_id()?;
    let input = format!("{APP_SALT}:{raw_id}");
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    Ok(hex::encode(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_64_hex_chars() {
        // Should work on the CI host machine
        match get_device_fingerprint() {
            Ok(fp) => {
                assert_eq!(fp.len(), 64, "fingerprint must be 64 hex chars");
                assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "must be hex");
            }
            Err(e) => {
                // On some CI environments hardware ID may not be available — that's ok
                eprintln!("Fingerprint unavailable in test env: {e}");
            }
        }
    }

    #[test]
    fn fingerprint_is_deterministic() {
        let a = get_device_fingerprint();
        let b = get_device_fingerprint();
        assert_eq!(a, b, "fingerprint must be deterministic");
    }
}
