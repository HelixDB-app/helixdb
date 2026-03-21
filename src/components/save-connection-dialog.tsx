"use client";

import { useState, useEffect, useMemo } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { SavedConnection, SshTunnelConfig } from "@/lib/types";
import { useSavedConnectionsStore } from "@/stores/saved-connections-store";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    normalizeConnectionCriticality,
    normalizeConnectionEnvironment,
    normalizeConnectionOwner,
} from "@/lib/connection-metadata";
import type { ConnectionCriticality, ConnectionEnvironment } from "@/lib/types";
import { Database, Loader2, Plug, AlertCircle, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

type ConnectionMode = "uri" | "fields";

interface SaveConnectionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    editConnection: SavedConnection | null;
    onSaveAndConnect?: (conn: SavedConnection) => void;
}

export function SaveConnectionDialog({
    open,
    onOpenChange,
    editConnection,
    onSaveAndConnect,
}: SaveConnectionDialogProps) {
    const { add, update, error, clearError } = useSavedConnectionsStore();
    const [name, setName] = useState("");
    const [mode, setMode] = useState<ConnectionMode>("uri");
    const [uriValue, setUriValue] = useState("");
    const [host, setHost] = useState("localhost");
    const [port, setPort] = useState("5432");
    const [database, setDatabase] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [environment, setEnvironment] = useState<ConnectionEnvironment>("dev");
    const [owner, setOwner] = useState("");
    const [criticality, setCriticality] = useState<ConnectionCriticality>("medium");
    const [saving, setSaving] = useState(false);
    const [saveAndConnect, setSaveAndConnect] = useState(false);

    const [useSshTunneling, setUseSshTunneling] = useState(false);
    const [tunnelHost, setTunnelHost] = useState("");
    const [tunnelPort, setTunnelPort] = useState("22");
    const [sshUsername, setSshUsername] = useState("");
    const [sshAuth, setSshAuth] = useState<"password" | "identity_file">("password");
    const [identityFilePath, setIdentityFilePath] = useState("");
    const [sshPassword, setSshPassword] = useState("");
    const [saveSshPassword, setSaveSshPassword] = useState(false);
    const [keepAliveSeconds, setKeepAliveSeconds] = useState("0");

    const isEdit = !!editConnection;

    useEffect(() => {
        if (open) {
            clearError();
            if (editConnection) {
                setName(editConnection.name);
                setUriValue(editConnection.connection_string);
                setEnvironment(normalizeConnectionEnvironment(editConnection.environment));
                setOwner(editConnection.owner ?? "");
                setCriticality(normalizeConnectionCriticality(editConnection.criticality));
                try {
                    const url = new URL(editConnection.connection_string);
                    setHost(url.hostname || "localhost");
                    setPort(url.port || "5432");
                    setDatabase(decodeURIComponent(url.pathname.slice(1)) || "");
                    setUsername(decodeURIComponent(url.username) || "");
                    setPassword(url.password ? decodeURIComponent(url.password) : "");
                } catch {}
                const st = editConnection.ssh_tunnel;
                setUseSshTunneling(st?.use_ssh_tunneling ?? false);
                setTunnelHost(st?.tunnel_host ?? "");
                setTunnelPort(String(st?.tunnel_port ?? 22));
                setSshUsername(st?.username ?? "");
                setSshAuth(st?.authentication === "identity_file" ? "identity_file" : "password");
                setIdentityFilePath(st?.identity_file_path ?? "");
                setSshPassword(st?.ssh_password ?? "");
                setSaveSshPassword(st?.save_ssh_password ?? false);
                setKeepAliveSeconds(String(st?.keep_alive_seconds ?? 0));
            } else {
                setName("");
                setUriValue("postgres://user:password@localhost:5432/database");
                setHost("localhost");
                setPort("5432");
                setDatabase("");
                setUsername("");
                setPassword("");
                setEnvironment("dev");
                setOwner("");
                setCriticality("medium");
                setUseSshTunneling(false);
                setTunnelHost("");
                setTunnelPort("22");
                setSshUsername("");
                setSshAuth("password");
                setIdentityFilePath("");
                setSshPassword("");
                setSaveSshPassword(false);
                setKeepAliveSeconds("0");
            }
            setSaveAndConnect(false);
        }
    }, [open, editConnection, clearError]);

    const computedUri = useMemo(() => {
        if (!username || !host || !database) return "";
        const passStr = password ? `:${encodeURIComponent(password)}` : "";
        return `postgres://${encodeURIComponent(username)}${passStr}@${host}:${port}/${encodeURIComponent(database)}`;
    }, [host, port, database, username, password]);

    const connectionString = mode === "uri" ? uriValue : computedUri;
    const isValid = name.trim().length > 0 && connectionString.trim().length > 0;

    const buildSshTunnelForSave = (): SshTunnelConfig | null => {
        if (!useSshTunneling || !tunnelHost.trim() || !sshUsername.trim()) return null;
        const port = Math.max(1, Math.min(65535, parseInt(tunnelPort, 10) || 22));
        const keepAlive = Math.max(0, parseInt(keepAliveSeconds, 10) || 0);
        return {
            use_ssh_tunneling: true,
            tunnel_host: tunnelHost.trim(),
            tunnel_port: port,
            username: sshUsername.trim(),
            authentication: sshAuth,
            identity_file_path: sshAuth === "identity_file" ? identityFilePath.trim() || undefined : undefined,
            ssh_password: sshAuth === "password" && saveSshPassword ? sshPassword : undefined,
            save_ssh_password: sshAuth === "password" ? saveSshPassword : undefined,
            keep_alive_seconds: keepAlive,
        };
    };

    const buildSshTunnelForConnect = (): SshTunnelConfig | null => {
        const base = buildSshTunnelForSave();
        if (!base) return null;
        if (base.authentication === "password") {
            return { ...base, ssh_password: sshPassword || base.ssh_password };
        }
        return base;
    };

    const handleSave = async (andConnect: boolean) => {
        if (!isValid) return;
        setSaving(true);
        setSaveAndConnect(andConnect);
        try {
            const ssh_tunnel = buildSshTunnelForSave();
            if (isEdit) {
                const updated: SavedConnection = {
                    ...editConnection,
                    name: name.trim(),
                    connection_string: connectionString.trim(),
                    environment: normalizeConnectionEnvironment(environment),
                    owner: normalizeConnectionOwner(owner),
                    criticality: normalizeConnectionCriticality(criticality),
                    ssh_tunnel: ssh_tunnel ?? null,
                };
                await update(updated);
                if (andConnect && onSaveAndConnect) {
                    const forConnect = { ...updated, ssh_tunnel: buildSshTunnelForConnect() ?? undefined };
                    onSaveAndConnect(forConnect);
                }
            } else {
                const saved = await add({
                    name: name.trim(),
                    connection_string: connectionString.trim(),
                    database_name: null,
                    environment: normalizeConnectionEnvironment(environment),
                    owner: normalizeConnectionOwner(owner),
                    criticality: normalizeConnectionCriticality(criticality),
                    ssh_tunnel: ssh_tunnel ?? null,
                });
                if (andConnect && onSaveAndConnect) {
                    const forConnect = { ...saved, ssh_tunnel: buildSshTunnelForConnect() ?? undefined };
                    onSaveAndConnect(forConnect);
                }
            }
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const handlePickIdentityFile = async () => {
        try {
            const selected = await openFileDialog({ directory: false, multiple: false });
            if (selected) setIdentityFilePath(selected);
        } catch {
            // User cancelled or dialog failed
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md h-[90vh] max-h-[90vh] border-border/50 bg-card shadow-2xl p-0 overflow-hidden flex flex-col gap-0">
                <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/30">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 shadow-md shrink-0">
                            <Database className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div>
                            <DialogTitle className="text-base font-semibold">
                                {isEdit ? "Edit connection" : "New connection"}
                            </DialogTitle>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {isEdit
                                    ? "Update name and connection details"
                                    : "Save a connection for quick access"}
                            </p>
                        </div>
                    </div>
                </DialogHeader>

                <ScrollArea className="flex-1 min-h-0 overflow-hidden">
                    <div className="px-6 py-4 pb-6 space-y-4">
                    <div>
                        <label className="text-xs text-muted-foreground block mb-1.5">Connection name</label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Production, Local"
                            className="mt-1.5 h-10 bg-background/50 border-border/50"
                            disabled={saving}
                        />
                    </div>

                    <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
                        <button
                            type="button"
                            onClick={() => setMode("uri")}
                            className={cn(
                                "flex-1 rounded-md py-1.5 text-xs font-medium transition-all",
                                mode === "uri"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            URI
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode("fields")}
                            className={cn(
                                "flex-1 rounded-md py-1.5 text-xs font-medium transition-all",
                                mode === "fields"
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            Fields
                        </button>
                    </div>

                    {mode === "uri" ? (
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1.5">Connection string</label>
                            <Input
                                value={uriValue}
                                onChange={(e) => setUriValue(e.target.value)}
                                placeholder="postgres://user:password@host:5432/dbname"
                                className="mt-1.5 h-10 font-mono text-xs bg-background/50 border-border/50"
                                disabled={saving}
                            />
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2">
                                <label className="text-xs text-muted-foreground block mb-1">Host</label>
                                <Input
                                    value={host}
                                    onChange={(e) => setHost(e.target.value)}
                                    className="mt-1 h-9 text-sm"
                                    disabled={saving}
                                />
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground block mb-1">Port</label>
                                <Input
                                    value={port}
                                    onChange={(e) => setPort(e.target.value)}
                                    className="mt-1 h-9 text-sm"
                                    disabled={saving}
                                />
                            </div>
                            <div className="col-span-3">
                                <label className="text-xs text-muted-foreground block mb-1">Database</label>
                                <Input
                                    value={database}
                                    onChange={(e) => setDatabase(e.target.value)}
                                    className="mt-1 h-9 text-sm"
                                    disabled={saving}
                                />
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground block mb-1">Username</label>
                                <Input
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="mt-1 h-9 text-sm"
                                    disabled={saving}
                                />
                            </div>
                            <div className="col-span-2">
                                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="mt-1 h-9 text-sm"
                                    disabled={saving}
                                />
                            </div>
                        </div>
                    )}

                    <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                SSH tunneling
                            </p>
                            <Switch
                                checked={useSshTunneling}
                                onCheckedChange={setUseSshTunneling}
                                disabled={saving}
                            />
                        </div>
                        {useSshTunneling && (
                            <div className="space-y-2.5 pt-1">
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="col-span-2">
                                        <label className="text-xs text-muted-foreground block mb-1">Tunnel host</label>
                                        <Input
                                            value={tunnelHost}
                                            onChange={(e) => setTunnelHost(e.target.value)}
                                            placeholder="e.g. bastion.example.com"
                                            className="h-9 text-sm"
                                            disabled={saving}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-muted-foreground block mb-1">Tunnel port</label>
                                        <Input
                                            value={tunnelPort}
                                            onChange={(e) => setTunnelPort(e.target.value)}
                                            placeholder="22"
                                            className="h-9 text-sm"
                                            disabled={saving}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">Username</label>
                                    <Input
                                        value={sshUsername}
                                        onChange={(e) => setSshUsername(e.target.value)}
                                        placeholder="SSH user"
                                        className="h-9 text-sm"
                                        disabled={saving}
                                    />
                                </div>
                                <div className="flex items-center gap-1 rounded-md bg-muted/50 p-1">
                                    <button
                                        type="button"
                                        onClick={() => setSshAuth("password")}
                                        className={cn(
                                            "flex-1 rounded py-1.5 text-xs font-medium",
                                            sshAuth === "password"
                                                ? "bg-background text-foreground shadow-sm"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        Password
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSshAuth("identity_file")}
                                        className={cn(
                                            "flex-1 rounded py-1.5 text-xs font-medium",
                                            sshAuth === "identity_file"
                                                ? "bg-background text-foreground shadow-sm"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        Identity file
                                    </button>
                                </div>
                                {sshAuth === "identity_file" && (
                                    <div className="flex gap-1">
                                        <Input
                                            value={identityFilePath}
                                            onChange={(e) => setIdentityFilePath(e.target.value)}
                                            placeholder="Path to private key"
                                            className="h-9 text-sm flex-1"
                                            disabled={saving}
                                        />
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            className="h-9 w-9 shrink-0"
                                            onClick={handlePickIdentityFile}
                                            disabled={saving}
                                        >
                                            <FolderOpen className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                )}
                                {sshAuth === "password" && (
                                    <>
                                        <div>
                                            <label className="text-xs text-muted-foreground block mb-1">Password</label>
                                            <Input
                                                type="password"
                                                value={sshPassword}
                                                onChange={(e) => setSshPassword(e.target.value)}
                                                className="h-9 text-sm"
                                                disabled={saving}
                                            />
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Switch
                                                checked={saveSshPassword}
                                                onCheckedChange={setSaveSshPassword}
                                                disabled={saving}
                                            />
                                            <label className="text-xs text-muted-foreground">Save password?</label>
                                        </div>
                                    </>
                                )}
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">Keep alive (seconds)</label>
                                    <Input
                                        value={keepAliveSeconds}
                                        onChange={(e) => setKeepAliveSeconds(e.target.value)}
                                        placeholder="0"
                                        className="h-9 text-sm w-24"
                                        disabled={saving}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-3">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Environment Manager
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-xs text-muted-foreground block mb-1">Environment</label>
                                <Select
                                    value={environment}
                                    onValueChange={(v) => setEnvironment(v as ConnectionEnvironment)}
                                    disabled={saving}
                                >
                                    <SelectTrigger className="h-9 text-sm">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="dev">Development</SelectItem>
                                        <SelectItem value="staging">Staging</SelectItem>
                                        <SelectItem value="prod">Production</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground block mb-1">Criticality</label>
                                <Select
                                    value={criticality}
                                    onValueChange={(v) => setCriticality(v as ConnectionCriticality)}
                                    disabled={saving}
                                >
                                    <SelectTrigger className="h-9 text-sm">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="low">Low</SelectItem>
                                        <SelectItem value="medium">Medium</SelectItem>
                                        <SelectItem value="high">High</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">Owner</label>
                            <Input
                                value={owner}
                                onChange={(e) => setOwner(e.target.value)}
                                placeholder="e.g. Data Platform Team"
                                className="h-9 text-sm"
                                disabled={saving}
                            />
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-4 py-3 border border-destructive/20">
                            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                            <p className="text-sm text-destructive">{error}</p>
                        </div>
                    )}
                    </div>
                </ScrollArea>

                <div className="shrink-0 px-6 pb-6 pt-4 flex flex-col gap-2 border-t border-border/30 bg-card/95 backdrop-blur-sm">
                    <Button
                        onClick={() => handleSave(true)}
                        disabled={saving || !isValid}
                        className="w-full h-10 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-medium"
                    >
                        {saving && saveAndConnect ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Plug className="h-4 w-4 mr-2" />
                        )}
                        {isEdit ? "Update & Connect" : "Save & Connect"}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleSave(false)}
                        disabled={saving || !isValid}
                        className="w-full h-10"
                    >
                        {saving && !saveAndConnect ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        {isEdit ? "Update" : "Save only"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
