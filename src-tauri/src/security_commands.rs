use crate::biometric;
use crate::security_prefs;

#[tauri::command]
pub fn security_get_biometric_lock() -> bool {
    security_prefs::load().biometric_app_lock
}

#[tauri::command]
pub fn security_set_biometric_lock(enabled: bool) -> Result<(), String> {
    if enabled && !biometric::status().can_enable_lock() {
        return Err("Biometric authentication is not available on this device.".into());
    }
    let mut p = security_prefs::load();
    p.biometric_app_lock = enabled;
    security_prefs::save(&p)
}

#[tauri::command]
pub fn security_get_biometric_sensitive_ops() -> bool {
    security_prefs::load().biometric_sensitive_operations
}

#[tauri::command]
pub fn security_set_biometric_sensitive_ops(enabled: bool) -> Result<(), String> {
    if enabled && !biometric::status().can_enable_lock() {
        return Err("Biometric authentication is not available on this device.".into());
    }
    let mut p = security_prefs::load();
    p.biometric_sensitive_operations = enabled;
    security_prefs::save(&p)
}

#[tauri::command]
pub fn biometric_get_status() -> crate::biometric::BiometricStatus {
    biometric::status()
}

#[tauri::command]
pub fn biometric_authenticate(reason: String) -> Result<(), String> {
    if !security_prefs::load().biometric_app_lock {
        return Ok(());
    }
    biometric::authenticate(reason.trim())
}

/// Optional pre-prompt from the UI before a sensitive action (Rust commands also enforce).
#[tauri::command]
pub fn biometric_authenticate_sensitive_action(reason: String) -> Result<(), String> {
    if !security_prefs::load().biometric_sensitive_operations {
        return Ok(());
    }
    biometric::authenticate(reason.trim())
}
