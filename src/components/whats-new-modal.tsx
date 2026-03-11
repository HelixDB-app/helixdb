"use client";

import { useEffect, useMemo, useState } from "react";
import { APP_VERSION } from "@/lib/app-config";
import { normalizeVersion } from "@/lib/app-update";
import { fetchReleaseNotes, type ReleaseNote } from "@/lib/release-notes";
import { isTauriRuntime } from "@/lib/runtime";
import { useSettingsStore } from "@/stores/settings-store";
import { ReleaseNotesModal } from "@/components/release-notes-modal";

function findMatchingRelease(notes: ReleaseNote[], version: string): ReleaseNote | null {
    const normalized = normalizeVersion(version);
    return notes.find((note) => normalizeVersion(note.version) === normalized) ?? notes[0] ?? null;
}

export function WhatsNewModal() {
    const { lastSeenVersion, updateSettings } = useSettingsStore();
    const [note, setNote] = useState<ReleaseNote | null>(null);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);

    const shouldShow = useMemo(() => {
        if (!lastSeenVersion) return true;
        return normalizeVersion(lastSeenVersion) !== normalizeVersion(APP_VERSION);
    }, [lastSeenVersion]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (!shouldShow) return;

        let active = true;
        setLoading(true);

        fetchReleaseNotes(6)
            .then(({ notes }) => {
                if (!active) return;
                const matched = findMatchingRelease(notes, APP_VERSION);
                if (!matched) {
                    return;
                }
                setNote(matched);
                setOpen(true);
            })
            .catch(() => {
                if (!active) return;
            })
            .finally(() => {
                if (!active) return;
                setLoading(false);
            });

        return () => {
            active = false;
        };
    }, [shouldShow]);

    function dismiss() {
        if (note) {
            updateSettings({ lastSeenVersion: APP_VERSION });
        }
        setOpen(false);
    }

    return (
        <ReleaseNotesModal
            open={open}
            note={note}
            loading={loading}
            onClose={dismiss}
        />
    );
}
