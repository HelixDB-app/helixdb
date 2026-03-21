import { create } from "zustand";
import { open } from "@tauri-apps/plugin-shell";
import { toast } from "sonner";
import {
  checkAppStoreUpdate,
  compareVersions,
  type AppStoreUpdateInfo,
} from "@/lib/app-update";
import { isBrowserOffline, notifyNoInternetDetected } from "@/lib/network-errors";
import { isTauriRuntime } from "@/lib/runtime";

type UpdateStatus = "idle" | "checking" | "available" | "up-to-date" | "error";

type UpdateCheckSource = "auto" | "manual";

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  appStoreUrl: string | null;
  trackId: number | null;
  lastCheckedAt: number | null;
  error: string | null;
  modalOpen: boolean;
  openingStore: boolean;
  checkForUpdates: (opts?: { source?: UpdateCheckSource }) => Promise<AppStoreUpdateInfo | null>;
  openAppStore: () => Promise<void>;
  setModalOpen: (open: boolean) => void;
}

function normalizeUpdateInfo(info: AppStoreUpdateInfo): AppStoreUpdateInfo {
  const latest = info.latestVersion ?? null;
  let available = info.updateAvailable;

  if (!available && latest) {
    available = compareVersions(info.currentVersion, latest) < 0;
  }

  return {
    ...info,
    latestVersion: latest,
    updateAvailable: available,
  };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  appStoreUrl: null,
  trackId: null,
  lastCheckedAt: null,
  error: null,
  modalOpen: false,
  openingStore: false,
  setModalOpen: (open) => set({ modalOpen: open }),
  checkForUpdates: async ({ source = "auto" } = {}) => {
    if (!isTauriRuntime()) return null;
    if (get().status === "checking") return null;

    if (isBrowserOffline()) {
      notifyNoInternetDetected();
      if (source === "manual") {
        set({
          modalOpen: true,
          status: "error",
          error: "You appear to be offline. Connect to the internet and try again.",
        });
      }
      return null;
    }

    if (source === "manual") {
      set({ modalOpen: true, status: "checking", error: null });
    } else {
      set({ status: "checking", error: null });
    }

    try {
      const rawInfo = await checkAppStoreUpdate();
      const info = normalizeUpdateInfo(rawInfo);

      set({
        status: info.updateAvailable ? "available" : "up-to-date",
        currentVersion: info.currentVersion,
        latestVersion: info.latestVersion,
        updateAvailable: info.updateAvailable,
        appStoreUrl: info.appStoreUrl,
        trackId: info.trackId,
        lastCheckedAt: Date.now(),
        error: null,
      });

      if (info.updateAvailable) {
        set({ modalOpen: true });
      } else if (source === "manual") {
        set({ modalOpen: true });
      }

      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const network = notifyNoInternetDetected(err);
      if (!network && source === "manual") {
        toast.error("Update check failed.");
      }
      set({
        status: "error",
        error: message,
        ...(source === "manual" ? { modalOpen: true } : {}),
      });
      return null;
    }
  },
  openAppStore: async () => {
    if (!isTauriRuntime()) return;

    const { appStoreUrl, trackId } = get();
    const url = trackId
      ? `macappstore://itunes.apple.com/app/id${trackId}?mt=12`
      : appStoreUrl;

    if (!url) {
      toast.error("App Store link unavailable.");
      return;
    }

    set({ openingStore: true });
    try {
      await open(url);
      set({ modalOpen: false });
    } catch (err) {
      toast.error("Failed to open the App Store.");
      throw err;
    } finally {
      set({ openingStore: false });
    }
  },
}));
