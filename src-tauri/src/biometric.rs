//! OS-native biometric prompts (desktop: Touch ID, Windows Hello).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BiometricStatus {
    Available,
    Unavailable { message: Option<String> },
    /// Used on Linux and other targets where there is no OS biometric API wired up.
    #[allow(dead_code)]
    NotSupported { message: Option<String> },
}

impl BiometricStatus {
    pub fn can_enable_lock(&self) -> bool {
        matches!(self, BiometricStatus::Available)
    }
}

/// Best-effort capability check (does not show UI).
pub fn status() -> BiometricStatus {
    #[cfg(target_os = "macos")]
    {
        macos::status()
    }
    #[cfg(target_os = "windows")]
    {
        windows_::status()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        BiometricStatus::NotSupported {
            message: Some("Biometric app lock is not supported on this platform.".into()),
        }
    }
}

/// Native biometric (or enrolled Hello) prompt.
pub fn authenticate(reason: &str) -> Result<(), String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("Authentication reason is required.".into());
    }

    #[cfg(target_os = "macos")]
    {
        macos::authenticate(reason)
    }
    #[cfg(target_os = "windows")]
    {
        windows_::authenticate(reason)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Biometric authentication is not available on this platform.".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::BiometricStatus;
    use block2::RcBlock;
    use dispatch::Queue;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::ffi::c_int;
    use std::sync::mpsc;

    extern "C" {
        fn pthread_main_np() -> c_int;
    }

    fn is_main_thread() -> bool {
        unsafe { pthread_main_np() != 0 }
    }

    fn ns_error_message(err: &NSError) -> String {
        err.localizedDescription().to_string()
    }

    pub fn status() -> BiometricStatus {
        let run = || unsafe {
            let ctx = LAContext::new();
            match ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) {
                Ok(()) => BiometricStatus::Available,
                Err(e) => BiometricStatus::Unavailable {
                    message: Some(ns_error_message(&e)),
                },
            }
        };

        if is_main_thread() {
            run()
        } else {
            Queue::main().exec_sync(run)
        }
    }

    pub fn authenticate(reason: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let reason = reason.to_string();

        let start = move || unsafe {
            let ctx = LAContext::new();
            if let Err(e) = ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
            {
                let _ = tx.send(Err(ns_error_message(&e)));
                return;
            }

            let ns_reason = NSString::from_str(&reason);
            let tx_ok = tx.clone();
            let block = RcBlock::new(
                move |success: Bool, error: *mut NSError| {
                    let res = if success.as_bool() {
                        Ok(())
                    } else if error.is_null() {
                        Err("Biometric authentication failed.".into())
                    } else {
                        Err(ns_error_message(&*error))
                    };
                    let _ = tx_ok.send(res);
                },
            );

            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &ns_reason,
                &block,
            );
        };

        if is_main_thread() {
            start();
        } else {
            Queue::main().exec_async(start);
        }

        rx.recv()
            .map_err(|_| "Authentication was interrupted.".to_string())?
    }
}

#[cfg(target_os = "windows")]
mod windows_ {
    use super::BiometricStatus;
    use windows::{
        core::{HSTRING, Interface},
        Security::Credentials::UI::{
            UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
        },
    };
    use windows_future::IAsyncOperation;

    pub fn status() -> BiometricStatus {
        let Ok(op) = UserConsentVerifier::CheckAvailabilityAsync() else {
            return BiometricStatus::Unavailable {
                message: Some("Could not query Windows Hello availability.".into()),
            };
        };
        let Ok(typed) = op.cast::<IAsyncOperation<UserConsentVerifierAvailability>>() else {
            return BiometricStatus::Unavailable {
                message: Some("Could not query Windows Hello availability.".into()),
            };
        };
        let Ok(avail) = typed.join() else {
            return BiometricStatus::Unavailable {
                message: Some("Could not query Windows Hello availability.".into()),
            };
        };

        match avail {
            UserConsentVerifierAvailability::Available => BiometricStatus::Available,
            UserConsentVerifierAvailability::DeviceNotPresent => BiometricStatus::Unavailable {
                message: Some("No authentication device is present.".into()),
            },
            UserConsentVerifierAvailability::NotConfiguredForUser => BiometricStatus::Unavailable {
                message: Some("Windows Hello is not set up for this user.".into()),
            },
            UserConsentVerifierAvailability::DisabledByPolicy => BiometricStatus::Unavailable {
                message: Some("Windows Hello is disabled by policy.".into()),
            },
            UserConsentVerifierAvailability::DeviceBusy => BiometricStatus::Unavailable {
                message: Some("Authentication device is busy. Try again.".into()),
            },
            _ => BiometricStatus::Unavailable {
                message: Some("Windows Hello is not available.".into()),
            },
        }
    }

    pub fn authenticate(reason: &str) -> Result<(), String> {
        match status() {
            BiometricStatus::Available => {}
            BiometricStatus::Unavailable { message } => {
                return Err(message.unwrap_or_else(|| "Biometrics unavailable.".into()));
            }
            BiometricStatus::NotSupported { message } => {
                return Err(message.unwrap_or_else(|| "Not supported.".into()));
            }
        }

        let msg = HSTRING::from(reason);
        let op = UserConsentVerifier::RequestVerificationAsync(&msg)
            .map_err(|e| format!("Windows Hello error: {e}"))?;
        let result = op
            .cast::<IAsyncOperation<UserConsentVerificationResult>>()
            .map_err(|e| format!("Windows Hello error: {e}"))?
            .join()
            .map_err(|e| format!("Windows Hello error: {e}"))?;

        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => Err("Verification was canceled.".into()),
            UserConsentVerificationResult::DeviceNotPresent => {
                Err("No authentication device is present.".into())
            }
            UserConsentVerificationResult::NotConfiguredForUser => {
                Err("Windows Hello is not set up for this user.".into())
            }
            UserConsentVerificationResult::DisabledByPolicy => {
                Err("Windows Hello is disabled by policy.".into())
            }
            UserConsentVerificationResult::DeviceBusy => {
                Err("Authentication device is busy. Try again.".into())
            }
            _ => Err("Windows Hello verification failed.".into()),
        }
    }
}
