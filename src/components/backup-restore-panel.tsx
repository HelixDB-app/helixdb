"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "@/stores/connection-store";
import { isTauri } from "@/lib/tauri-runtime";
import {
    backupGetModuleState,
    backupEstimateSize,
    backupRunNow,
    backupRestore,
    backupUpsertSchedule,
    backupDeleteSchedule,
    backupDeleteRecord,
    backupConnectGoogleDrive,
    backupDisconnectGoogleDrive,
    authOpenBrowser,
    openPath,
} from "@/lib/tauri";
import type {
    BackupCloudSyncStatus,
    BackupModuleState,
    BackupProgressPayload,
    BackupRecord,
    BackupSchedule,
    BackupScope,
    BackupSizeEstimate,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    AlertCircle,
    ArchiveRestore,
    CheckCircle2,
    Clock3,
    Cloud,
    CloudOff,
    Download,
    FolderOpen,
    HardDriveDownload,
    HardDriveUpload,
    Loader2,
    RefreshCw,
    RotateCcw,
    Save,
    Server,
    ShieldCheck,
    Trash2,
    Wrench,
} from "lucide-react";

const CRON_PRESETS: Array<{ label: string; cron: string; description: string }> = [
    { label: "Every hour", cron: "0 * * * *", description: "Runs at the top of every hour." },
    { label: "Nightly 2 AM", cron: "0 2 * * *", description: "Runs every day at 2:00 AM." },
    { label: "Weekdays 6 PM", cron: "0 18 * * 1-5", description: "Runs Monday to Friday at 6:00 PM." },
    { label: "Sunday 3 AM", cron: "0 3 * * 0", description: "Runs once each Sunday at 3:00 AM." },
];

function formatBytes(bytes?: number | null): string {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDateTime(epochMs?: number | null): string {
    if (!epochMs) return "Never";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(epochMs);
}

function formatRelative(epochMs?: number | null): string {
    if (!epochMs) return "Never";
    const deltaMs = epochMs - Date.now();
    const absMinutes = Math.round(Math.abs(deltaMs) / 60_000);
    if (absMinutes < 1) return "now";
    if (absMinutes < 60) return `${absMinutes}m ${deltaMs >= 0 ? "from now" : "ago"}`;
    const absHours = Math.round(absMinutes / 60);
    if (absHours < 48) return `${absHours}h ${deltaMs >= 0 ? "from now" : "ago"}`;
    const absDays = Math.round(absHours / 24);
    return `${absDays}d ${deltaMs >= 0 ? "from now" : "ago"}`;
}

function cloudSyncTone(status?: BackupCloudSyncStatus | null) {
    switch (status) {
        case "synced":
            return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-300";
        case "failed":
            return "bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-300";
        case "pending":
            return "bg-cyan-500/10 text-cyan-700 border-cyan-500/20 dark:text-cyan-300";
        case "skipped":
            return "bg-muted text-muted-foreground border-border/50";
        default:
            return "bg-muted text-muted-foreground border-border/50";
    }
}

function ProgressBar({ value }: { value: number }) {
    return (
        <div className="h-2 overflow-hidden rounded-full bg-foreground/8">
            <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-cyan-500 to-sky-500 transition-all duration-300"
                style={{ width: `${Math.max(4, Math.min(100, value))}%` }}
            />
        </div>
    );
}

function EmptyDesktopMessage() {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <Alert className="max-w-xl border-border/60 bg-card/80 shadow-sm">
                <Wrench className="h-4 w-4" />
                <AlertTitle>Backup & Restore is desktop-first</AlertTitle>
                <AlertDescription>
                    The Rust worker, PostgreSQL CLI integration, and background scheduler are available inside
                    the Tauri desktop app. Open this workspace there to run secure local backups and restores.
                </AlertDescription>
            </Alert>
        </div>
    );
}

export function BackupRestorePanel() {
    const {
        connectionId,
        connectionString,
        databaseName,
        serverVersion,
        sshTunnel,
        connections,
        activeConnectionId,
    } = useConnectionStore(
        useShallow((state) => ({
            connectionId: state.connectionId,
            connectionString: state.connectionString,
            databaseName: state.databaseName,
            serverVersion: state.serverVersion,
            sshTunnel: state.sshTunnel,
            connections: state.connections,
            activeConnectionId: state.activeConnectionId,
        }))
    );

    const [moduleState, setModuleState] = useState<BackupModuleState | null>(null);
    const [estimate, setEstimate] = useState<BackupSizeEstimate | null>(null);
    const [manualScope, setManualScope] = useState<BackupScope>("database");
    const [manualName, setManualName] = useState("");
    const [outputRoot, setOutputRoot] = useState("");
    const [syncToDrive, setSyncToDrive] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isRunningBackup, setIsRunningBackup] = useState(false);
    const [isRunningRestore, setIsRunningRestore] = useState(false);
    const [isSavingSchedule, setIsSavingSchedule] = useState(false);
    const [isConnectingDrive, setIsConnectingDrive] = useState(false);
    const [isDisconnectingDrive, setIsDisconnectingDrive] = useState(false);
    const [backupProgress, setBackupProgress] = useState<BackupProgressPayload | null>(null);
    const [restoreProgress, setRestoreProgress] = useState<BackupProgressPayload | null>(null);
    const [driveActionError, setDriveActionError] = useState<string | null>(null);
    const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
    const [selectedClusterDatabase, setSelectedClusterDatabase] = useState("");
    const [restoreTargetMode, setRestoreTargetMode] = useState<"same" | "different">("same");
    const [restoreTargetDatabase, setRestoreTargetDatabase] = useState("");
    const [restoreCreateIfMissing, setRestoreCreateIfMissing] = useState(true);
    const [restoreClean, setRestoreClean] = useState(true);
    const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
    const [scheduleName, setScheduleName] = useState("");
    const [scheduleCron, setScheduleCron] = useState("0 2 * * *");
    const [scheduleScope, setScheduleScope] = useState<BackupScope>("database");
    const [scheduleEnabled, setScheduleEnabled] = useState(true);
    const [scheduleSyncToDrive, setScheduleSyncToDrive] = useState(false);

    const activeConnection = useMemo(
        () => connections.find((entry) => entry.connectionId === activeConnectionId) ?? null,
        [connections, activeConnectionId]
    );
    const connectionLabel = activeConnection?.label ?? databaseName ?? "Active connection";
    const latestBackup = moduleState?.backups[0] ?? null;
    const selectedBackup = useMemo(
        () => moduleState?.backups.find((record) => record.id === selectedBackupId) ?? null,
        [moduleState, selectedBackupId]
    );
    const selectedBackupDatabaseArtifacts = useMemo(
        () => selectedBackup?.artifacts.filter((artifact) => artifact.kind === "database") ?? [],
        [selectedBackup]
    );
    const activeSchedulesCount = moduleState?.schedules.filter((schedule) => schedule.enabled).length ?? 0;
    const successfulBackupsCount =
        moduleState?.backups.filter((record) => record.status === "success").length ?? 0;
    const googleDriveFolderUrl = moduleState?.google_drive.folder_id
        ? `https://drive.google.com/drive/folders/${moduleState.google_drive.folder_id}`
        : null;

    const loadModuleState = useCallback(async () => {
        setIsLoading(true);
        try {
            const state = await backupGetModuleState();
            setModuleState(state);
            setOutputRoot((current) => current || state.default_output_root);
            setSyncToDrive((current) => current && state.google_drive.configured ? current : false);
            setScheduleSyncToDrive((current) => current && state.google_drive.configured ? current : false);
            setSelectedBackupId((current) => current ?? state.backups[0]?.id ?? null);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to load backup module.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadEstimate = useCallback(async () => {
        if (!connectionId) {
            setEstimate(null);
            return;
        }
        try {
            const nextEstimate = await backupEstimateSize(connectionId, manualScope);
            setEstimate(nextEstimate);
        } catch {
            setEstimate(null);
        }
    }, [connectionId, manualScope]);

    useEffect(() => {
        if (!isTauri()) return;
        void loadModuleState();
    }, [loadModuleState]);

    useEffect(() => {
        if (!isTauri()) return;
        void loadEstimate();
    }, [loadEstimate]);

    useEffect(() => {
        if (!selectedBackup) return;
        const sameDb = selectedBackup.source_database ?? databaseName;
        setRestoreTargetDatabase((current) => current || sameDb || "");
        setSelectedClusterDatabase((current) => {
            if (selectedBackup.scope !== "cluster") return "";
            if (current) return current;
            return (
                selectedBackup.artifacts.find((artifact) => artifact.kind === "database")?.database_name ?? ""
            );
        });
    }, [selectedBackup, databaseName]);

    useEffect(() => {
        if (!isTauri()) return;
        let mounted = true;
        let unlistenProgress: (() => void) | undefined;
        let unlistenRestore: (() => void) | undefined;
        let unlistenChanged: (() => void) | undefined;

        void (async () => {
            unlistenProgress = await listen<BackupProgressPayload>("backup-job-progress", (event) => {
                if (!mounted) return;
                setBackupProgress(event.payload);
            });
            unlistenRestore = await listen<BackupProgressPayload>("backup-restore-progress", (event) => {
                if (!mounted) return;
                setRestoreProgress(event.payload);
            });
            unlistenChanged = await listen("backup-module-changed", () => {
                if (!mounted) return;
                void loadModuleState();
            });
        })();

        return () => {
            mounted = false;
            unlistenProgress?.();
            unlistenRestore?.();
            unlistenChanged?.();
        };
    }, [loadModuleState]);

    const scheduleConnectionSnapshot = useMemo(() => {
        if (editingScheduleId) {
            const editing = moduleState?.schedules.find((schedule) => schedule.id === editingScheduleId);
            if (editing) {
                return {
                    connectionLabel: editing.connection_label,
                    connectionString: editing.connection_string,
                    sshTunnel: editing.ssh_tunnel ?? null,
                    sourceDatabase: editing.source_database ?? databaseName,
                };
            }
        }
        return {
            connectionLabel,
            connectionString,
            sshTunnel: sshTunnel ?? null,
            sourceDatabase: databaseName,
        };
    }, [editingScheduleId, moduleState, connectionLabel, connectionString, sshTunnel, databaseName]);

    const handlePickDirectory = useCallback(async () => {
        try {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const selected = await open({ directory: true, multiple: false });
            if (typeof selected === "string" && selected.trim()) {
                setOutputRoot(selected);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to open folder picker.");
        }
    }, []);

    const handleOpenOutputRoot = useCallback(async () => {
        const target = outputRoot || moduleState?.default_output_root;
        if (!target) return;
        try {
            await openPath(target);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to open backup folder.");
        }
    }, [moduleState?.default_output_root, outputRoot]);

    const handleRunBackup = useCallback(async () => {
        if (!connectionString) {
            toast.error("Connect to a database before running a backup.");
            return;
        }
        setIsRunningBackup(true);
        setBackupProgress(null);
        try {
            const result = await backupRunNow({
                connection_id: connectionId,
                connection_label: connectionLabel,
                connection_string: connectionString,
                ssh_tunnel: sshTunnel ?? null,
                scope: manualScope,
                source_database: manualScope === "database" ? databaseName : databaseName,
                output_root: outputRoot || moduleState?.default_output_root || null,
                sync_to_google_drive: syncToDrive,
                name: manualName.trim() || null,
                estimated_bytes: estimate?.estimated_bytes ?? null,
            });
            setSelectedBackupId(result.id);
            toast.success(
                result.cloud_sync_status === "failed"
                    ? "Backup completed locally, but Google Drive sync needs attention."
                    : "Backup completed successfully."
            );
            setManualName("");
            await loadModuleState();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Backup failed.");
        } finally {
            setIsRunningBackup(false);
        }
    }, [
        connectionId,
        connectionLabel,
        connectionString,
        databaseName,
        estimate?.estimated_bytes,
        loadModuleState,
        manualName,
        manualScope,
        moduleState?.default_output_root,
        outputRoot,
        sshTunnel,
        syncToDrive,
    ]);

    const handleRunRestore = useCallback(async () => {
        if (!selectedBackup || !connectionString) {
            toast.error("Pick a backup and an active connection before restoring.");
            return;
        }
        const targetDatabase =
            restoreTargetMode === "same"
                ? selectedBackup.source_database ?? databaseName
                : restoreTargetDatabase.trim();
        if (!targetDatabase) {
            toast.error("Enter a target database name.");
            return;
        }
        setIsRunningRestore(true);
        setRestoreProgress(null);
        try {
            const result = await backupRestore({
                backup_id: selectedBackup.id,
                connection_string: connectionString,
                ssh_tunnel: sshTunnel ?? null,
                target_database: targetDatabase,
                source_database: selectedBackup.scope === "cluster" ? selectedClusterDatabase : null,
                create_database_if_missing: restoreCreateIfMissing,
                clean_restore: restoreClean,
            });
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Restore failed.");
        } finally {
            setIsRunningRestore(false);
        }
    }, [
        connectionString,
        databaseName,
        restoreTargetMode,
        restoreTargetDatabase,
        restoreCreateIfMissing,
        restoreClean,
        selectedBackup,
        selectedClusterDatabase,
        sshTunnel,
    ]);

    const startEditingSchedule = useCallback(
        (schedule: BackupSchedule) => {
            setEditingScheduleId(schedule.id);
            setScheduleName(schedule.name);
            setScheduleCron(schedule.cron);
            setScheduleScope(schedule.scope);
            setScheduleEnabled(schedule.enabled);
            setScheduleSyncToDrive(schedule.sync_to_google_drive);
        },
        []
    );

    const resetScheduleForm = useCallback(() => {
        setEditingScheduleId(null);
        setScheduleName("");
        setScheduleCron("0 2 * * *");
        setScheduleScope("database");
        setScheduleEnabled(true);
        setScheduleSyncToDrive(false);
    }, []);

    const handleSaveSchedule = useCallback(async () => {
        if (!scheduleConnectionSnapshot.connectionString) {
            toast.error("Connect to a database before creating a backup schedule.");
            return;
        }
        setIsSavingSchedule(true);
        try {
            await backupUpsertSchedule({
                id: editingScheduleId,
                name:
                    scheduleName.trim() ||
                    `${scheduleScope === "cluster" ? "Cluster" : "Database"} backup ${scheduleConnectionSnapshot.connectionLabel}`,
                enabled: scheduleEnabled,
                cron: scheduleCron.trim(),
                scope: scheduleScope,
                source_database:
                    scheduleScope === "database" ? scheduleConnectionSnapshot.sourceDatabase ?? databaseName : null,
                connection_label: scheduleConnectionSnapshot.connectionLabel,
                connection_string: scheduleConnectionSnapshot.connectionString,
                output_root: outputRoot || moduleState?.default_output_root || null,
                sync_to_google_drive: scheduleSyncToDrive,
                ssh_tunnel: scheduleConnectionSnapshot.sshTunnel,
            });
            toast.success(editingScheduleId ? "Schedule updated." : "Schedule saved.");
            resetScheduleForm();
            await loadModuleState();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save schedule.");
        } finally {
            setIsSavingSchedule(false);
        }
    }, [
        databaseName,
        editingScheduleId,
        loadModuleState,
        moduleState?.default_output_root,
        outputRoot,
        resetScheduleForm,
        scheduleConnectionSnapshot,
        scheduleCron,
        scheduleEnabled,
        scheduleName,
        scheduleScope,
        scheduleSyncToDrive,
    ]);

    const handleDeleteSchedule = useCallback(async (scheduleId: string) => {
        try {
            await backupDeleteSchedule(scheduleId);
            toast.success("Schedule deleted.");
            if (editingScheduleId === scheduleId) resetScheduleForm();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to delete schedule.");
        }
    }, [editingScheduleId, resetScheduleForm]);

    const handleToggleSchedule = useCallback(async (schedule: BackupSchedule, enabled: boolean) => {
        try {
            await backupUpsertSchedule({
                id: schedule.id,
                name: schedule.name,
                enabled,
                cron: schedule.cron,
                scope: schedule.scope,
                source_database: schedule.source_database ?? null,
                connection_label: schedule.connection_label,
                connection_string: schedule.connection_string,
                output_root: schedule.output_root,
                sync_to_google_drive: schedule.sync_to_google_drive,
                ssh_tunnel: schedule.ssh_tunnel ?? null,
            });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to update schedule.");
        }
    }, []);

    const handleRunScheduleNow = useCallback(async (schedule: BackupSchedule) => {
        setIsRunningBackup(true);
        setBackupProgress(null);
        try {
            const result = await backupRunNow({
                connection_id: null,
                connection_label: schedule.connection_label,
                connection_string: schedule.connection_string,
                ssh_tunnel: schedule.ssh_tunnel ?? null,
                scope: schedule.scope,
                source_database: schedule.source_database ?? null,
                output_root: schedule.output_root,
                sync_to_google_drive: schedule.sync_to_google_drive,
                name: schedule.name,
                schedule_id: schedule.id,
                estimated_bytes: null,
            });
            setSelectedBackupId(result.id);
            toast.success("Scheduled backup ran successfully.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Scheduled backup failed.");
        } finally {
            setIsRunningBackup(false);
        }
    }, []);

    const handleDeleteBackup = useCallback(async (record: BackupRecord) => {
        try {
            await backupDeleteRecord(record.id, true);
            toast.success("Backup deleted.");
            if (selectedBackupId === record.id) {
                setSelectedBackupId(null);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to delete backup.");
        }
    }, [selectedBackupId]);

    const handleConnectDrive = useCallback(async () => {
        setIsConnectingDrive(true);
        setDriveActionError(null);
        try {
            const status = await backupConnectGoogleDrive();
            if (status.has_refresh_token) {
                toast.success("Google Drive connected. HelixDB will sync into the HelixDB Backups folder.");
            } else {
                toast.success("Google Drive connected for this session. Long-lived sync may require reconnecting later.");
            }
            await loadModuleState();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to connect Google Drive.";
            setDriveActionError(message);
            toast.error(message);
        } finally {
            setIsConnectingDrive(false);
        }
    }, [loadModuleState]);

    const handleDisconnectDrive = useCallback(async () => {
        setIsDisconnectingDrive(true);
        setDriveActionError(null);
        try {
            await backupDisconnectGoogleDrive();
            setSyncToDrive(false);
            setScheduleSyncToDrive(false);
            toast.success("Google Drive disconnected.");
            await loadModuleState();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to disconnect Google Drive.";
            setDriveActionError(message);
            toast.error(message);
        } finally {
            setIsDisconnectingDrive(false);
        }
    }, [loadModuleState]);

    const handleOpenDriveFolder = useCallback(async () => {
        if (!googleDriveFolderUrl) return;
        try {
            await authOpenBrowser(googleDriveFolderUrl);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to open Google Drive folder.");
        }
    }, [googleDriveFolderUrl]);

    if (!isTauri()) {
        return <EmptyDesktopMessage />;
    }

    return (
        <div className="h-full overflow-auto bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(14,165,233,0.14),transparent_22%),linear-gradient(180deg,rgba(15,23,42,0.02),transparent_40%)]">
            <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
                <Card className="relative overflow-hidden border-emerald-500/20 bg-card/85 backdrop-blur-sm">
                    <div className="pointer-events-none absolute inset-y-0 right-0 w-80 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.18),transparent_55%)]" />
                    <CardHeader className="relative">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300">
                                        <ShieldCheck className="h-3 w-3" />
                                        Rust worker
                                    </Badge>
                                    <Badge variant="outline" className="border-cyan-500/25 bg-cyan-500/8 text-cyan-700 dark:text-cyan-300">
                                        <Server className="h-3 w-3" />
                                        PSQL toolchain
                                    </Badge>
                                </div>
                                <div>
                                    <CardTitle className="text-2xl tracking-tight">Backup & Restore</CardTitle>
                                    <CardDescription className="mt-2 max-w-3xl text-sm leading-6">
                                        Run database-level or full-cluster backups in the background, keep versioned history on the user’s machine,
                                        and optionally sync finished artifacts to Google Drive. Restore flows stay guided so you can target the
                                        same database or redirect into a different one cleanly.
                                    </CardDescription>
                                </div>
                            </div>

                            <div className="grid gap-3 rounded-2xl border border-border/50 bg-background/65 p-4 shadow-sm sm:grid-cols-3 lg:min-w-[29rem]">
                                <div>
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Connected DB</div>
                                    <div className="mt-2 text-sm font-semibold">{databaseName || "No database"}</div>
                                    <div className="text-xs text-muted-foreground">{connectionLabel}</div>
                                </div>
                                <div>
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Server</div>
                                    <div className="mt-2 text-sm font-semibold">{serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? "Unknown"}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {moduleState?.capabilities.pg_dump_version ?? "Waiting for CLI check"}
                                    </div>
                                </div>
                                <div className="flex items-end justify-start sm:justify-end">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="border-emerald-500/20 bg-emerald-500/8 hover:bg-emerald-500/12"
                                        onClick={handleOpenOutputRoot}
                                    >
                                        <FolderOpen className="h-4 w-4" />
                                        Open backup root
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="relative">
                        <div className="grid gap-4 md:grid-cols-3">
                            <Card className="gap-3 border-border/60 bg-background/70 py-4">
                                <CardHeader className="pb-0">
                                    <CardTitle className="text-sm">Latest backup</CardTitle>
                                    <CardDescription>
                                        {latestBackup ? formatDateTime(latestBackup.started_at) : "No backups yet"}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="pt-0">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl font-semibold">{latestBackup ? formatBytes(latestBackup.bytes_written) : "0 B"}</div>
                                        <HardDriveDownload className="h-5 w-5 text-emerald-500" />
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="gap-3 border-border/60 bg-background/70 py-4">
                                <CardHeader className="pb-0">
                                    <CardTitle className="text-sm">Schedules</CardTitle>
                                    <CardDescription>{activeSchedulesCount} active recurring jobs</CardDescription>
                                </CardHeader>
                                <CardContent className="pt-0">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl font-semibold">{activeSchedulesCount}</div>
                                        <Clock3 className="h-5 w-5 text-cyan-500" />
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="gap-3 border-border/60 bg-background/70 py-4">
                                <CardHeader className="pb-0">
                                    <CardTitle className="text-sm">Healthy backups</CardTitle>
                                    <CardDescription>Successful versions available for restore</CardDescription>
                                </CardHeader>
                                <CardContent className="pt-0">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl font-semibold">{successfulBackupsCount}</div>
                                        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {(backupProgress || restoreProgress) && (
                            <div className="mt-6 grid gap-4 lg:grid-cols-2">
                                {backupProgress && (
                                    <Card className="border-emerald-500/20 bg-emerald-500/6 py-4">
                                        <CardHeader className="pb-0">
                                            <CardTitle className="text-sm">Backup in progress</CardTitle>
                                            <CardDescription>{backupProgress.message}</CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-3 pt-0">
                                            <ProgressBar value={backupProgress.percent} />
                                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                                <span>{backupProgress.phase}</span>
                                                <span>
                                                    Step {backupProgress.current} / {backupProgress.total}
                                                </span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                                {restoreProgress && (
                                    <Card className="border-cyan-500/20 bg-cyan-500/6 py-4">
                                        <CardHeader className="pb-0">
                                            <CardTitle className="text-sm">Restore in progress</CardTitle>
                                            <CardDescription>{restoreProgress.message}</CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-3 pt-0">
                                            <ProgressBar value={restoreProgress.percent} />
                                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                                <span>{restoreProgress.phase}</span>
                                                <span>
                                                    Step {restoreProgress.current} / {restoreProgress.total}
                                                </span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {moduleState?.capabilities.notes.length ? (
                    <Alert className="border-amber-500/20 bg-amber-500/6">
                        <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-300" />
                        <AlertTitle>PostgreSQL client toolchain status</AlertTitle>
                        <AlertDescription className="space-y-1">
                            {moduleState.capabilities.notes.map((note) => (
                                <p key={note}>{note}</p>
                            ))}
                        </AlertDescription>
                    </Alert>
                ) : null}

                <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
                    <div className="grid gap-6">
                        <Card className="border-border/60 bg-card/85">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <HardDriveUpload className="h-4 w-4 text-emerald-500" />
                                    Manual backup
                                </CardTitle>
                                <CardDescription>
                                    One-click backups run through `pg_dump` or `pg_dumpall` in a dedicated background worker so the app’s active pools stay out of the hot path.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-5">
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>Backup scope</Label>
                                        <Select value={manualScope} onValueChange={(value) => setManualScope(value as BackupScope)}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="database">Current database</SelectItem>
                                                <SelectItem value="cluster">Full cluster</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Friendly name</Label>
                                        <Input
                                            value={manualName}
                                            onChange={(event) => setManualName(event.target.value)}
                                            placeholder={manualScope === "cluster" ? "Nightly cluster snapshot" : `${databaseName} pre-release backup`}
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-4 md:grid-cols-[1.4fr_0.8fr_0.8fr]">
                                    <div className="space-y-2">
                                        <Label>Storage root</Label>
                                        <div className="flex gap-2">
                                            <Input value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} />
                                            <Button variant="outline" size="sm" onClick={handlePickDirectory}>
                                                <FolderOpen className="h-4 w-4" />
                                                Browse
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Estimated size</Label>
                                        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm font-medium">
                                            {estimate ? formatBytes(estimate.estimated_bytes) : "Estimating…"}
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Drive sync</Label>
                                        <div className="flex h-10 items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3">
                                            <div className="text-sm">
                                                {moduleState?.google_drive.configured ? "Enabled" : "Optional"}
                                            </div>
                                            <Switch
                                                checked={syncToDrive}
                                                onCheckedChange={setSyncToDrive}
                                                disabled={!moduleState?.google_drive.configured}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-emerald-500/8 to-transparent p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Source</div>
                                        <div className="mt-2 text-sm font-semibold">
                                            {manualScope === "cluster" ? connectionLabel : databaseName}
                                        </div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {manualScope === "cluster"
                                                ? "Creates globals plus per-database archives in a structured cluster bundle."
                                                : "Creates a compressed custom archive for the active database only."}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-cyan-500/8 to-transparent p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Destination</div>
                                        <div className="mt-2 text-sm font-semibold truncate">{outputRoot || moduleState?.default_output_root}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            Folder layout is versioned by scope, date, and backup id for clean history tracking.
                                        </div>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                    <Button
                                        onClick={handleRunBackup}
                                        disabled={!moduleState?.capabilities.ready_for_backup || !connectionId || isRunningBackup}
                                        className="bg-emerald-600 text-white hover:bg-emerald-500"
                                    >
                                        {isRunningBackup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                        Run backup now
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => void loadEstimate()}>
                                        <RefreshCw className="h-4 w-4" />
                                        Refresh estimate
                                    </Button>
                                    <div className="text-xs text-muted-foreground">
                                        {moduleState?.capabilities.pg_dump_version ?? "PostgreSQL CLI not detected yet"}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="border-border/60 bg-card/85">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <ArchiveRestore className="h-4 w-4 text-cyan-500" />
                                    Guided restore
                                </CardTitle>
                                <CardDescription>
                                    Pick any retained backup version and restore it back into the same database or redirect the restore into a separate target for safe validation.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-5">
                                <div className="space-y-2">
                                    <Label>Selected backup</Label>
                                    <Select value={selectedBackupId ?? ""} onValueChange={setSelectedBackupId}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Choose a backup version" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {(moduleState?.backups ?? []).map((record) => (
                                                <SelectItem key={record.id} value={record.id}>
                                                    {record.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                {selectedBackup ? (
                                    <>
                                        <div className="grid gap-4 md:grid-cols-3">
                                            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Captured</div>
                                                <div className="mt-2 text-sm font-semibold">{formatDateTime(selectedBackup.started_at)}</div>
                                                <div className="text-xs text-muted-foreground">{formatBytes(selectedBackup.bytes_written)}</div>
                                            </div>
                                            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Scope</div>
                                                <div className="mt-2 text-sm font-semibold capitalize">{selectedBackup.scope}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {selectedBackup.source_database ?? connectionLabel}
                                                </div>
                                            </div>
                                            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Cloud sync</div>
                                                <div className="mt-2">
                                                    <Badge variant="outline" className={cn("capitalize", cloudSyncTone(selectedBackup.cloud_sync_status))}>
                                                        {selectedBackup.cloud_sync_status ?? "local"}
                                                    </Badge>
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {selectedBackup.cloud_sync_message ?? "Stored locally on this machine."}
                                                </div>
                                            </div>
                                        </div>

                                        {selectedBackup.scope === "cluster" && (
                                            <div className="space-y-2">
                                                <Label>Database inside this cluster backup</Label>
                                                <Select value={selectedClusterDatabase} onValueChange={setSelectedClusterDatabase}>
                                                    <SelectTrigger>
                                                        <SelectValue placeholder="Choose a database from the cluster bundle" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {selectedBackupDatabaseArtifacts.map((artifact) => (
                                                            <SelectItem key={artifact.id} value={artifact.database_name ?? artifact.label}>
                                                                {artifact.database_name ?? artifact.label}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        )}

                                        <div className="grid gap-4 md:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label>Restore target</Label>
                                                <div className="flex gap-2">
                                                    <Button
                                                        type="button"
                                                        variant={restoreTargetMode === "same" ? "default" : "outline"}
                                                        size="sm"
                                                        onClick={() => {
                                                            setRestoreTargetMode("same");
                                                            setRestoreTargetDatabase(selectedBackup.source_database ?? databaseName);
                                                        }}
                                                    >
                                                        Same database
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant={restoreTargetMode === "different" ? "default" : "outline"}
                                                        size="sm"
                                                        onClick={() => setRestoreTargetMode("different")}
                                                    >
                                                        Different database
                                                    </Button>
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <Label>Target database name</Label>
                                                <Input
                                                    value={
                                                        restoreTargetMode === "same"
                                                            ? selectedBackup.source_database ?? databaseName
                                                            : restoreTargetDatabase
                                                    }
                                                    onChange={(event) => setRestoreTargetDatabase(event.target.value)}
                                                    disabled={restoreTargetMode === "same"}
                                                />
                                            </div>
                                        </div>

                                        <div className="grid gap-3 md:grid-cols-2">
                                            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                                                <div>
                                                    <div className="text-sm font-medium">Create target DB if missing</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        Uses `psql` to provision the target before restore if needed.
                                                    </div>
                                                </div>
                                                <Switch checked={restoreCreateIfMissing} onCheckedChange={setRestoreCreateIfMissing} />
                                            </div>
                                            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                                                <div>
                                                    <div className="text-sm font-medium">Clean before restore</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        Runs `pg_restore --clean --if-exists` for a sharper, deterministic restore.
                                                    </div>
                                                </div>
                                                <Switch checked={restoreClean} onCheckedChange={setRestoreClean} />
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-3">
                                            <Button
                                                onClick={handleRunRestore}
                                                disabled={
                                                    !moduleState?.capabilities.ready_for_restore ||
                                                    isRunningRestore ||
                                                    (selectedBackup.scope === "cluster" && !selectedClusterDatabase)
                                                }
                                                className="bg-cyan-600 text-white hover:bg-cyan-500"
                                            >
                                                {isRunningRestore ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                                                Run restore
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => selectedBackup && openPath(selectedBackup.backup_dir).catch(() => {})}
                                            >
                                                <FolderOpen className="h-4 w-4" />
                                                Open backup folder
                                            </Button>
                                        </div>
                                    </>
                                ) : (
                                    <Alert className="border-border/60">
                                        <ArchiveRestore className="h-4 w-4" />
                                        <AlertTitle>No backup selected</AlertTitle>
                                        <AlertDescription>
                                            Create a backup first, or choose an existing version from history to start a restore.
                                        </AlertDescription>
                                    </Alert>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid gap-6">
                        <Card className="border-border/60 bg-card/85">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Cloud className="h-4 w-4 text-cyan-500" />
                                    Storage & sync
                                </CardTitle>
                                <CardDescription>
                                    Keep a clean local folder structure by default, then optionally add Google Drive sync for off-device retention.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-5">
                                <div className="space-y-2">
                                    <Label>Default local backup root</Label>
                                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
                                        {outputRoot || moduleState?.default_output_root}
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-cyan-500/8 to-transparent p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="text-sm font-semibold">Google Drive sync</div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                Optional. Sign in once and HelixDB will create or reuse a dedicated Drive folder for off-device backup copies.
                                            </div>
                                        </div>
                                        <Badge
                                            variant="outline"
                                            className={cn(
                                                moduleState?.google_drive.configured
                                                    ? "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                                                    : "border-border/60 bg-muted/20 text-muted-foreground"
                                            )}
                                        >
                                            {moduleState?.google_drive.configured ? "Configured" : "Local only"}
                                        </Badge>
                                    </div>

                                    <div className="mt-4 grid gap-4">
                                        <div className="space-y-4 min-w-0">
                                            <div className="grid gap-3 md:grid-cols-2">
                                                <div className="min-w-0 rounded-xl border border-border/60 bg-background/70 p-3">
                                                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Drive folder</div>
                                                    <div className="mt-2 text-sm font-semibold">
                                                        {moduleState?.google_drive.configured ? "HelixDB Backups" : "Not connected"}
                                                    </div>
                                                    <div className="mt-1 break-all text-xs text-muted-foreground">
                                                        {moduleState?.google_drive.folder_id
                                                            ? `ID: ${moduleState.google_drive.folder_id}`
                                                            : "Created automatically after sign-in."}
                                                    </div>
                                                </div>
                                                <div className="min-w-0 rounded-xl border border-border/60 bg-background/70 p-3">
                                                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Account</div>
                                                    <div className="mt-2 break-all text-sm font-semibold">
                                                        {moduleState?.google_drive.connected_email ?? "Waiting for connection"}
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {moduleState?.google_drive.connected_at
                                                            ? `Connected ${formatDateTime(moduleState.google_drive.connected_at)}`
                                                            : "No Google account linked yet."}
                                                    </div>
                                                </div>
                                                <div className="min-w-0 rounded-xl border border-border/60 bg-background/70 p-3 md:col-span-2">
                                                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Security</div>
                                                    <div className="mt-2 text-sm font-semibold">
                                                        {moduleState?.google_drive.has_refresh_token ? "Keychain stored" : "Reconnect required"}
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {moduleState?.google_drive.access_token_expires_at
                                                            ? `Token refreshes automatically, current access expires ${formatRelative(moduleState.google_drive.access_token_expires_at)}.`
                                                            : "Refresh tokens stay in the OS keychain instead of backup metadata."}
                                                    </div>
                                                </div>
                                            </div>

                                            {isConnectingDrive && (
                                                <Alert className="border-cyan-500/20 bg-cyan-500/8 text-cyan-900 dark:text-cyan-100">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    <AlertTitle>Finishing Google Drive connection</AlertTitle>
                                                    <AlertDescription>
                                                        Complete the browser approval, then wait a moment while HelixDB stores tokens and prepares the Drive folder.
                                                    </AlertDescription>
                                                </Alert>
                                            )}

                                            <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                                                <div className="flex items-start gap-3">
                                                    <HardDriveUpload className="mt-0.5 h-4 w-4 text-cyan-500" />
                                                    <div className="space-y-1">
                                                        <div className="text-sm font-medium">How cloud sync works</div>
                                                        <div className="text-xs leading-5 text-muted-foreground">
                                                            HelixDB opens Google sign-in in your browser, requests Drive access for files it creates,
                                                            stores the refresh token in your OS keychain, and uploads each backup into a timestamped
                                                            folder under <span className="font-medium text-foreground">HelixDB Backups</span>.
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {driveActionError && (
                                                <Alert className="border-amber-500/20 bg-amber-500/8 text-amber-900 dark:text-amber-100">
                                                    <AlertCircle className="h-4 w-4" />
                                                    <AlertTitle>Google Drive sync needs attention</AlertTitle>
                                                    <AlertDescription>{driveActionError}</AlertDescription>
                                                </Alert>
                                            )}
                                            <div className="grid gap-3 md:grid-cols-3">
                                                <Button
                                                    onClick={handleConnectDrive}
                                                    disabled={isConnectingDrive || isDisconnectingDrive}
                                                    className="justify-start"
                                                >
                                                    {isConnectingDrive ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : moduleState?.google_drive.configured ? (
                                                        <RefreshCw className="h-4 w-4" />
                                                    ) : (
                                                        <Cloud className="h-4 w-4" />
                                                    )}
                                                    {isConnectingDrive
                                                        ? "Waiting for Google approval"
                                                        : moduleState?.google_drive.configured
                                                          ? "Reconnect Google Drive"
                                                          : "Connect Google Drive"}
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={handleOpenDriveFolder}
                                                    disabled={!googleDriveFolderUrl || isConnectingDrive || isDisconnectingDrive}
                                                    className="justify-start"
                                                >
                                                    <FolderOpen className="h-4 w-4" />
                                                    Open Drive folder
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={handleDisconnectDrive}
                                                    disabled={!moduleState?.google_drive.configured || isConnectingDrive || isDisconnectingDrive}
                                                    className="justify-start"
                                                >
                                                    {isDisconnectingDrive ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <CloudOff className="h-4 w-4" />
                                                    )}
                                                    Disconnect Drive
                                                </Button>
                                            </div>

                                            <div className="rounded-xl border border-dashed border-border/70 bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
                                                Requires <span className="font-mono text-foreground">GOOGLE_DRIVE_CLIENT_ID</span> in the desktop app
                                                environment. If your Google OAuth client also requires a secret, add{" "}
                                                <span className="font-mono text-foreground">GOOGLE_DRIVE_CLIENT_SECRET</span> too. Setup is completed
                                                through Google sign-in, then the final status comes back into HelixDB after token storage and folder
                                                preparation finish.
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="border-border/60 bg-card/85">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Clock3 className="h-4 w-4 text-emerald-500" />
                                    Scheduler
                                </CardTitle>
                                <CardDescription>
                                    Save cron-based backup jobs tied to the current connection settings. The desktop scheduler checks them in the background and writes new versions into the same backup history.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-5">
                                <div className="space-y-2">
                                    <Label>Schedule name</Label>
                                    <Input
                                        value={scheduleName}
                                        onChange={(event) => setScheduleName(event.target.value)}
                                        placeholder={editingScheduleId ? "Edit backup job" : "Nightly prod backup"}
                                    />
                                </div>

                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>Scope</Label>
                                        <Select value={scheduleScope} onValueChange={(value) => setScheduleScope(value as BackupScope)}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="database">Current database</SelectItem>
                                                <SelectItem value="cluster">Full cluster</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Cron</Label>
                                        <Input value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} />
                                    </div>
                                </div>

                                <div className="grid gap-2">
                                    <Label>Quick presets</Label>
                                    <div className="flex flex-wrap gap-2">
                                        {CRON_PRESETS.map((preset) => (
                                            <Button
                                                key={preset.cron}
                                                type="button"
                                                variant="outline"
                                                size="xs"
                                                onClick={() => setScheduleCron(preset.cron)}
                                                title={preset.description}
                                            >
                                                {preset.label}
                                            </Button>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid gap-3">
                                    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                                        <div>
                                            <div className="text-sm font-medium">Enable this schedule</div>
                                            <div className="text-xs text-muted-foreground">Due runs are picked up automatically by the desktop scheduler loop.</div>
                                        </div>
                                        <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
                                    </div>
                                    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                                        <div>
                                            <div className="text-sm font-medium">Sync scheduled backups to Drive</div>
                                            <div className="text-xs text-muted-foreground">Only enabled when Google Drive is connected.</div>
                                        </div>
                                        <Switch
                                            checked={scheduleSyncToDrive}
                                            onCheckedChange={setScheduleSyncToDrive}
                                            disabled={!moduleState?.google_drive.configured}
                                        />
                                    </div>
                                </div>

                                <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                                    <div>Connection snapshot: {scheduleConnectionSnapshot.connectionLabel}</div>
                                    <div className="mt-1">
                                        Source: {scheduleScope === "cluster" ? "Full cluster" : scheduleConnectionSnapshot.sourceDatabase ?? databaseName}
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                    <Button onClick={handleSaveSchedule} disabled={isSavingSchedule}>
                                        {isSavingSchedule ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                        {editingScheduleId ? "Update schedule" : "Save schedule"}
                                    </Button>
                                    {editingScheduleId && (
                                        <Button variant="outline" onClick={resetScheduleForm}>
                                            Cancel edit
                                        </Button>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
                    <Card className="border-border/60 bg-card/85">
                        <CardHeader>
                            <CardTitle className="text-base">Backup history</CardTitle>
                            <CardDescription>
                                Versioned restore points with local path tracking, sync status, and direct actions for open, restore, and delete.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ScrollArea className="max-h-[28rem]">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Scope</TableHead>
                                            <TableHead>Started</TableHead>
                                            <TableHead>Size</TableHead>
                                            <TableHead>Sync</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isLoading ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                                                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                                                    Loading backup history…
                                                </TableCell>
                                            </TableRow>
                                        ) : (moduleState?.backups.length ?? 0) === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                                                    No backup versions yet. Run the first one from the manual backup card above.
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            moduleState?.backups.map((record) => (
                                                <TableRow
                                                    key={record.id}
                                                    className={cn("cursor-pointer", selectedBackupId === record.id && "bg-emerald-500/6")}
                                                    onClick={() => setSelectedBackupId(record.id)}
                                                >
                                                    <TableCell>
                                                        <div className="font-medium">{record.name}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {record.source_database ?? record.connection_label}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="capitalize">{record.scope}</TableCell>
                                                    <TableCell>
                                                        <div>{formatDateTime(record.started_at)}</div>
                                                        <div className="text-xs text-muted-foreground">{formatRelative(record.started_at)}</div>
                                                    </TableCell>
                                                    <TableCell>{formatBytes(record.bytes_written)}</TableCell>
                                                    <TableCell>
                                                        <Badge variant="outline" className={cn("capitalize", cloudSyncTone(record.cloud_sync_status))}>
                                                            {record.cloud_sync_status ?? "local"}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="flex justify-end gap-2">
                                                            <Button
                                                                variant="ghost"
                                                                size="xs"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    setSelectedBackupId(record.id);
                                                                }}
                                                            >
                                                                Restore
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="xs"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    void openPath(record.backup_dir).catch(() => {
                                                                        toast.error("Failed to open backup folder.");
                                                                    });
                                                                }}
                                                            >
                                                                Open
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="xs"
                                                                className="text-destructive hover:text-destructive"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    void handleDeleteBackup(record);
                                                                }}
                                                            >
                                                                Delete
                                                            </Button>
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 bg-card/85">
                        <CardHeader>
                            <CardTitle className="text-base">Schedules list</CardTitle>
                            <CardDescription>
                                Edit, pause, run, or delete saved cron jobs. Each one keeps its own connection snapshot so the job remains reproducible.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ScrollArea className="max-h-[28rem]">
                                <div className="space-y-3">
                                    {(moduleState?.schedules.length ?? 0) === 0 ? (
                                        <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
                                            No schedules yet. Save one from the scheduler card to automate backups.
                                        </div>
                                    ) : (
                                        moduleState?.schedules.map((schedule) => (
                                            <div key={schedule.id} className="rounded-xl border border-border/60 bg-background/55 p-4 shadow-sm">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="space-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="font-semibold">{schedule.name}</div>
                                                            <Badge variant="outline" className="capitalize">
                                                                {schedule.scope}
                                                            </Badge>
                                                            {schedule.enabled ? (
                                                                <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300">
                                                                    Active
                                                                </Badge>
                                                            ) : (
                                                                <Badge variant="outline" className="border-border/60 bg-muted/20 text-muted-foreground">
                                                                    Paused
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <div className="text-xs text-muted-foreground">{schedule.connection_label}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            Cron {schedule.cron} · next {formatDateTime(schedule.next_run_at)} ({formatRelative(schedule.next_run_at)})
                                                        </div>
                                                        {schedule.last_status && (
                                                            <div className="text-xs text-muted-foreground">
                                                                Last run {formatDateTime(schedule.last_run_at)} · {schedule.last_status}
                                                            </div>
                                                        )}
                                                        {schedule.last_error && (
                                                            <div className="text-xs text-amber-700 dark:text-amber-300">{schedule.last_error}</div>
                                                        )}
                                                    </div>

                                                    <Switch
                                                        checked={schedule.enabled}
                                                        onCheckedChange={(checked) => void handleToggleSchedule(schedule, checked)}
                                                    />
                                                </div>

                                                <div className="mt-4 flex flex-wrap gap-2">
                                                    <Button variant="outline" size="xs" onClick={() => startEditingSchedule(schedule)}>
                                                        Edit
                                                    </Button>
                                                    <Button variant="outline" size="xs" onClick={() => void handleRunScheduleNow(schedule)}>
                                                        Run now
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="xs"
                                                        className="text-destructive hover:text-destructive"
                                                        onClick={() => void handleDeleteSchedule(schedule.id)}
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                        Delete
                                                    </Button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
