import { invoke } from "@tauri-apps/api/core";

export interface AppStoreUpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  appStoreUrl: string | null;
  releaseNotes: string | null;
  trackId: number | null;
  fetchedAt: string;
}

export async function checkAppStoreUpdate(): Promise<AppStoreUpdateInfo> {
  return invoke<AppStoreUpdateInfo>("app_store_check_update");
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) =>
    normalizeVersion(v)
      .split(/[.+-]/)
      .map((part) => {
        const digits = part.match(/^\d+/)?.[0] ?? "0";
        return Number(digits);
      });

  const left = normalize(a);
  const right = normalize(b);
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  return 0;
}
