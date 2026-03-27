import { invoke } from "@tauri-apps/api/core";

export type BiometricStatusPayload =
    | { kind: "available" }
    | { kind: "unavailable"; message?: string }
    | { kind: "notSupported"; message?: string };

export function securityGetBiometricLock(): Promise<boolean> {
    return invoke<boolean>("security_get_biometric_lock");
}

export function securitySetBiometricLock(enabled: boolean): Promise<void> {
    return invoke("security_set_biometric_lock", { enabled });
}

export function biometricGetStatus(): Promise<BiometricStatusPayload> {
    return invoke<BiometricStatusPayload>("biometric_get_status");
}

export function biometricAuthenticate(reason: string): Promise<void> {
    return invoke("biometric_authenticate", { reason });
}

export function securityGetBiometricSensitiveOps(): Promise<boolean> {
    return invoke<boolean>("security_get_biometric_sensitive_ops");
}

export function securitySetBiometricSensitiveOps(enabled: boolean): Promise<void> {
    return invoke("security_set_biometric_sensitive_ops", { enabled });
}

/** Optional UI-side pre-prompt; server commands also enforce when the setting is on. */
export function biometricAuthenticateSensitiveAction(reason: string): Promise<void> {
    return invoke("biometric_authenticate_sensitive_action", { reason });
}
