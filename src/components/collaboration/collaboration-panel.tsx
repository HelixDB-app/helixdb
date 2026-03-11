"use client";

import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import {
    Copy,
    Link2,
    LogOut,
    MessageSquare,
    Mic,
    MicOff,
    MonitorUp,
    MonitorX,
    Send,
    Users,
    Video,
    VideoOff,
    X,
} from "lucide-react";
import { useCollaborationStore, getCollaborationColor, getCollaborationPermissions } from "@/stores/collaboration-store";
import type { CollaborationAccessLevel, CollaborationParticipant, CollaborationRemoteMedia } from "@/lib/collaboration/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
    getMediaPermissionStatus,
    openMediaPermissionSettings,
    requestMediaPermissions,
    type MediaPermissionSnapshot,
    type MediaPermissionState,
} from "@/lib/tauri";
import { useIdeFsStore } from "@/stores/ide-fs-store";

interface CollaborationPanelProps {
    connectionId: string | null;
    className?: string;
}

function permissionStateLabel(state: MediaPermissionState): string {
    switch (state) {
        case "authorized":
            return "Allowed";
        case "denied":
            return "Denied";
        case "restricted":
            return "Restricted";
        case "not_determined":
            return "Not requested";
        case "unsupported":
        default:
            return "Unavailable";
    }
}

function permissionStateBadgeClass(state: MediaPermissionState): string {
    switch (state) {
        case "authorized":
            return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
        case "denied":
        case "restricted":
            return "border-red-500/40 bg-red-500/10 text-red-200";
        case "not_determined":
            return "border-amber-500/40 bg-amber-500/10 text-amber-200";
        case "unsupported":
        default:
            return "border-zinc-500/40 bg-zinc-500/10 text-zinc-300";
    }
}

type MediaTile = { id: string; title: string; subtitle?: string; stream: MediaStream | null; color: string };

function VideoBubble({
    title,
    subtitle,
    stream,
    color,
    onClick,
}: {
    title: string;
    subtitle?: string;
    stream: MediaStream | null;
    color: string;
    onClick?: () => void;
}) {
    const ref = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || !stream) return;
        el.srcObject = stream;
        const play = () => {
            el.play().catch(() => {});
        };
        if (el.readyState >= 2) play();
        else el.addEventListener("loadedmetadata", play, { once: true });
        return () => {
            el.removeEventListener("loadedmetadata", play);
        };
    }, [stream]);

    const content = (
        <>
            {stream ? (
                <video
                    ref={ref}
                    autoPlay
                    muted
                    playsInline
                    className="h-full w-full rounded-full object-cover"
                />
            ) : (
                <div className="flex h-full w-full items-center justify-center rounded-full bg-card/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {title.slice(0, 2)}
                </div>
            )}
            <span
                className="absolute -bottom-1.5 rounded-full px-2 py-0.5 text-[9px] font-semibold text-black"
                style={{ backgroundColor: color }}
            >
                {title}
            </span>
            {subtitle && (
                <span className="absolute -top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] text-zinc-200">
                    {subtitle}
                </span>
            )}
        </>
    );

    return onClick ? (
        <button
            type="button"
            onClick={onClick}
            className="relative flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border border-border/30 bg-black/45 shadow-sm transition hover:scale-105 hover:border-primary/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
            {content}
        </button>
    ) : (
        <div className="relative flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border border-border/30 bg-black/45 shadow-sm">
            {content}
        </div>
    );
}

function MediaPreviewDialog({
    tile,
    onClose,
}: {
    tile: MediaTile;
    onClose: () => void;
}) {
    const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
        if (!el || !tile.stream) return;
        el.srcObject = tile.stream;
        const play = () => {
            el.play().catch(() => {});
        };
        if (el.readyState >= 2) play();
        else el.addEventListener("loadedmetadata", play, { once: true });
    }, [tile.stream]);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[95vh] w-[95vw] max-w-4xl border-border/40 bg-zinc-950 p-0 overflow-hidden">
                <DialogHeader className="sr-only">
                    <DialogTitle>{tile.title} • {tile.subtitle ?? "Media"}</DialogTitle>
                </DialogHeader>
                <div className="relative flex flex-col">
                    <div className="flex items-center justify-between border-b border-border/30 px-4 py-2">
                        <span className="text-sm font-medium text-foreground">
                            {tile.title}
                            {tile.subtitle && (
                                <span className="ml-2 text-muted-foreground">• {tile.subtitle}</span>
                            )}
                        </span>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Close">
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                    <div className="relative aspect-video min-h-[320px] w-full bg-black">
                        {tile.stream ? (
                            <video
                                ref={setVideoRef}
                                autoPlay
                                muted
                                playsInline
                                className="h-full w-full object-contain"
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                No stream
                            </div>
                        )}
                        <div
                            className="absolute bottom-2 left-2 rounded-full px-2.5 py-1 text-[10px] font-semibold text-black"
                            style={{ backgroundColor: tile.color }}
                        >
                            {tile.title}
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function RemoteAudioSink({
    stream,
    participantName,
}: {
    stream: MediaStream;
    participantName: string;
}) {
    const ref = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        const audio = ref.current;
        if (!audio) return;
        audio.srcObject = stream;
        const play = async () => {
            try {
                await audio.play();
            } catch {
                // Autoplay can be blocked by runtime policy; user interaction usually unlocks it.
            }
        };
        void play();
    }, [stream]);

    return <audio ref={ref} autoPlay playsInline data-participant={participantName} className="hidden" />;
}

function ParticipantRow({
    participant,
    isHost,
    localUserId,
    onAccessChange,
}: {
    participant: CollaborationParticipant;
    isHost: boolean;
    localUserId: string | null;
    onAccessChange: (userId: string, access: CollaborationAccessLevel) => void;
}) {
    const color = getCollaborationColor(participant.colorIndex);
    const canEditRole = isHost && participant.id !== localUserId;

    return (
        <div className="flex items-center gap-2 rounded-md border border-border/25 bg-card/20 px-2 py-1.5">
            <Avatar className="h-7 w-7 border border-border/20">
                <AvatarImage src={participant.avatar ?? undefined} alt={participant.name} />
                <AvatarFallback style={{ backgroundColor: `${color}33`, color }}>{participant.initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground/90">{participant.name}</p>
                <p className="truncate text-[10px] text-muted-foreground/75">
                    {participant.isLocal ? "You" : "Participant"}
                    {participant.activeDocKey ? ` • ${participant.activeDocKey}` : ""}
                </p>
            </div>
            {canEditRole ? (
                <Select
                    value={participant.accessLevel}
                    onValueChange={(value) => onAccessChange(participant.id, value as CollaborationAccessLevel)}
                >
                    <SelectTrigger className="h-7 w-[88px] border-border/30 text-[10px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="view">View</SelectItem>
                        <SelectItem value="edit">Edit</SelectItem>
                        <SelectItem value="delete">Delete</SelectItem>
                    </SelectContent>
                </Select>
            ) : (
                <Badge variant="outline" className="border-border/30 bg-background/20 text-[10px] capitalize">
                    {participant.accessLevel}
                </Badge>
            )}
        </div>
    );
}

export function CollaborationPanel({ connectionId, className }: CollaborationPanelProps) {
    const {
        status,
        roomId,
        shareUrl,
        error,
        participants,
        chatMessages,
        localAccessLevel,
        localUserId,
        localMicEnabled,
        localCameraEnabled,
        localScreenEnabled,
        localCameraStream,
        localScreenStream,
        remoteMedia,
        createRoom,
        joinRoom,
        leaveRoom,
        sendChatMessage,
        setParticipantAccess,
        setConnectionContext,
        setLocalMicEnabled,
        setLocalCameraEnabled,
        setLocalScreenEnabled,
    } = useCollaborationStore(
        useShallow((state) => ({
            status: state.status,
            roomId: state.roomId,
            shareUrl: state.shareUrl,
            error: state.error,
            participants: state.participants,
            chatMessages: state.chatMessages,
            localAccessLevel: state.localAccessLevel,
            localUserId: state.localUserId,
            localMicEnabled: state.localMicEnabled,
            localCameraEnabled: state.localCameraEnabled,
            localScreenEnabled: state.localScreenEnabled,
            localCameraStream: state.localCameraStream,
            localScreenStream: state.localScreenStream,
            remoteMedia: state.remoteMedia,
            createRoom: state.createRoom,
            joinRoom: state.joinRoom,
            leaveRoom: state.leaveRoom,
            sendChatMessage: state.sendChatMessage,
            setParticipantAccess: state.setParticipantAccess,
            setConnectionContext: state.setConnectionContext,
            setLocalMicEnabled: state.setLocalMicEnabled,
            setLocalCameraEnabled: state.setLocalCameraEnabled,
            setLocalScreenEnabled: state.setLocalScreenEnabled,
        }))
    );

    const [joinInput, setJoinInput] = useState("");
    const [chatInput, setChatInput] = useState("");
    const [permissionSnapshot, setPermissionSnapshot] = useState<MediaPermissionSnapshot | null>(null);
    const [requestingPermissions, setRequestingPermissions] = useState(false);
    const [expandedMedia, setExpandedMedia] = useState<MediaTile | null>(null);
    const workspaceFileCount = useIdeFsStore((state) => (
        connectionId ? state.getFileCount(connectionId) : 0
    ));
    const mediaSupport = useMemo(() => {
        if (typeof navigator === "undefined") {
            return {
                getUserMedia: false,
                getDisplayMedia: false,
            };
        }
        return {
            getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
            getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === "function",
        };
    }, []);

    const permissionEntries = useMemo(
        () => permissionSnapshot ? [
            { key: "camera", label: "Camera", state: permissionSnapshot.camera },
            { key: "microphone", label: "Microphone", state: permissionSnapshot.microphone },
            { key: "screen", label: "Screen", state: permissionSnapshot.screen },
        ] : [],
        [permissionSnapshot]
    );

    const hasPermissionGaps = useMemo(
        () => permissionEntries.some((entry) => entry.state !== "authorized" && entry.state !== "unsupported"),
        [permissionEntries]
    );

    const showMediaHelp = !mediaSupport.getUserMedia || !mediaSupport.getDisplayMedia || hasPermissionGaps;

    useEffect(() => {
        setConnectionContext(connectionId);
    }, [connectionId, setConnectionContext]);

    useEffect(() => {
        let active = true;
        const loadStatus = async () => {
            try {
                const snapshot = await getMediaPermissionStatus();
                if (active) {
                    setPermissionSnapshot(snapshot);
                }
            } catch {
                if (active) {
                    setPermissionSnapshot(null);
                }
            }
        };
        void loadStatus();
        return () => {
            active = false;
        };
    }, [status]);

    const participantList = useMemo(
        () => Object.values(participants).sort((a, b) => {
            if (a.id === localUserId) return -1;
            if (b.id === localUserId) return 1;
            if (a.accessLevel === "host") return -1;
            if (b.accessLevel === "host") return 1;
            return a.name.localeCompare(b.name);
        }),
        [participants, localUserId]
    );
    const MAX_PARTICIPANTS_RENDER = 180;
    const visibleParticipants = useMemo(
        () => participantList.slice(0, MAX_PARTICIPANTS_RENDER),
        [participantList]
    );
    const hiddenParticipantCount = participantList.length - visibleParticipants.length;

    const { canEdit, canDelete } = getCollaborationPermissions(localAccessLevel);

    const mediaTiles = useMemo(() => {
        const tiles: Array<{ id: string; title: string; subtitle?: string; stream: MediaStream | null; color: string }> = [];

        if (localCameraStream) {
            tiles.push({ id: "local-camera", title: "You", subtitle: "Camera", stream: localCameraStream, color: "#22c55e" });
        }
        if (localScreenStream) {
            tiles.push({ id: "local-screen", title: "You", subtitle: "Screen", stream: localScreenStream, color: "#f59e0b" });
        }

        for (const participant of participantList) {
            if (participant.id === localUserId) continue;
            const media = remoteMedia[participant.id] as CollaborationRemoteMedia | undefined;
            if (!media) continue;
            const color = getCollaborationColor(participant.colorIndex);
            if (media.cameraStream) {
                tiles.push({
                    id: `${participant.id}-camera`,
                    title: participant.name.split(" ")[0] ?? participant.name,
                    subtitle: "Camera",
                    stream: media.cameraStream,
                    color,
                });
            }
            if (media.screenStream) {
                tiles.push({
                    id: `${participant.id}-screen`,
                    title: participant.name.split(" ")[0] ?? participant.name,
                    subtitle: "Screen",
                    stream: media.screenStream,
                    color,
                });
            }
        }

        return tiles;
    }, [localCameraStream, localScreenStream, participantList, remoteMedia, localUserId]);

    const remoteAudioStreams = useMemo(() => {
        const streams: Array<{ id: string; name: string; stream: MediaStream }> = [];
        for (const participant of participantList) {
            if (participant.id === localUserId) continue;
            const media = remoteMedia[participant.id] as CollaborationRemoteMedia | undefined;
            if (!media?.audioStream) continue;
            streams.push({
                id: `${participant.id}-audio`,
                name: participant.name,
                stream: media.audioStream,
            });
        }
        return streams;
    }, [participantList, remoteMedia, localUserId]);

    const handleCopyShareUrl = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            toast.success("Collaboration link copied");
        } catch {
            toast.error("Could not copy the link");
        }
    };

    const handleCreateRoom = async () => {
        await createRoom(connectionId);
    };

    const handleJoinRoom = async () => {
        const room = joinInput.trim();
        if (!room) return;
        await joinRoom(room, connectionId);
    };

    const handleSendChat = async () => {
        const text = chatInput.trim();
        if (!text) return;
        await sendChatMessage(text);
        setChatInput("");
    };

    const handleOpenPermissionSettings = async (scope: "camera" | "microphone" | "screen") => {
        try {
            await openMediaPermissionSettings(scope);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Could not open system settings.";
            toast.error(message);
        }
    };

    const handleRequestAllPermissions = async () => {
        setRequestingPermissions(true);
        try {
            const snapshot = await requestMediaPermissions();
            setPermissionSnapshot(snapshot);
            const allReady = [snapshot.camera, snapshot.microphone, snapshot.screen]
                .every((state) => state === "authorized" || state === "unsupported");

            if (allReady) {
                toast.success("Media permissions updated. Restart PGStudio if camera/screen still appear unavailable.");
            } else {
                toast("Some permissions are still blocked. Allow them in System Settings and restart PGStudio.");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Could not request media permissions.";
            toast.error(message);
        } finally {
            setRequestingPermissions(false);
        }
    };

    return (
        <aside className={cn("flex h-full w-full flex-col overflow-hidden border-l border-border/25 bg-card/15", className)}>
            {remoteAudioStreams.map((entry) => (
                <RemoteAudioSink key={entry.id} stream={entry.stream} participantName={entry.name} />
            ))}
            <div className="flex items-center justify-between border-b border-border/20 px-3 py-2">
                <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-cyan-400" />
                    <div>
                        <p className="text-xs font-semibold text-foreground/90">Live Collaboration</p>
                        <p className="text-[10px] text-muted-foreground/70">Role: {localAccessLevel ?? "view"}</p>
                    </div>
                </div>
                <div className="">

                <Badge
                    variant="outline"
                    className={cn(
                        "text-[10px]",
                        status === "connected" && "border-emerald-500/40 text-emerald-400",
                        status === "connecting" && "border-amber-500/40 text-amber-400",
                        status === "error" && "border-red-500/40 text-red-400"
                    )}
                    >
                    {status}
                </Badge>
                    </div>
            </div>

            {status !== "connected" ? (
                <div className="space-y-3 px-3 py-3">
                    <p className="text-[11px] text-muted-foreground/75">
                        Start a room or join one using a shareable collaboration URL.
                    </p>
                    {error && (
                        <div className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300">
                            {error}
                        </div>
                    )}
                    <div className="space-y-2">
                        <Button size="sm" className="w-full gap-1.5" onClick={handleCreateRoom} disabled={!connectionId || status === "connecting"}>
                            <Link2 className="h-3.5 w-3.5" />
                            Create Collaboration Room
                        </Button>
                        <div className="flex gap-1.5">
                            <Input
                                value={joinInput}
                                onChange={(e) => setJoinInput(e.target.value)}
                                placeholder="Enter room id"
                                className="h-8 text-xs"
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        void handleJoinRoom();
                                    }
                                }}
                            />
                            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={handleJoinRoom}>
                                Join
                            </Button>
                        </div>
                    </div>
                    {!connectionId && (
                        <p className="text-[10px] text-amber-400/90">
                            Connect to a database first, then join collaboration.
                        </p>
                    )}
                </div>
            ) : (
                <>
                    <div className="space-y-2 border-b border-border/20 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-foreground/90">Room {roomId}</p>
                                <p className="truncate text-[10px] text-muted-foreground/70">{participantList.length} participants connected</p>
                            </div>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[10px]" onClick={handleCopyShareUrl}>
                                    <Copy className="h-3 w-3" /> Copy link
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[10px]" onClick={() => void leaveRoom()}>
                                    <LogOut className="h-3 w-3" /> Leave
                                </Button>
                            </div>
                        </div>
                        {shareUrl && (
                            <div className="rounded-md border border-border/25 bg-background/35 px-2 py-1 font-mono text-[10px] text-muted-foreground/90">
                                {shareUrl}
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/70">
                            <Badge variant="secondary" className="text-[10px]">{canEdit ? "Edit enabled" : "Read only"}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{canDelete ? "Delete enabled" : "Delete restricted"}</Badge>
                            <Badge variant="secondary" className="text-[10px]">Media stage up to 12 peers</Badge>
                            <Badge variant="secondary" className="text-[10px]">
                                Workspace sync live • {workspaceFileCount} files
                            </Badge>
                        </div>
                    </div>

                    <div className="space-y-2 border-b border-border/20 px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                            <Button
                                size="sm"
                                variant={localMicEnabled ? "default" : "outline"}
                                className="h-7 gap-1.5 px-2 text-[10px]"
                                disabled={!mediaSupport.getUserMedia}
                                onClick={() => void setLocalMicEnabled(!localMicEnabled)}
                            >
                                {localMicEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
                                {localMicEnabled ? "Mic on" : "Mic off"}
                            </Button>
                            <Button
                                size="sm"
                                variant={localCameraEnabled ? "default" : "outline"}
                                className="h-7 gap-1.5 px-2 text-[10px]"
                                disabled={!mediaSupport.getUserMedia}
                                onClick={() => void setLocalCameraEnabled(!localCameraEnabled)}
                            >
                                {localCameraEnabled ? <Video className="h-3 w-3" /> : <VideoOff className="h-3 w-3" />}
                                {localCameraEnabled ? "Cam on" : "Cam off"}
                            </Button>
                            <Button
                                size="sm"
                                variant={localScreenEnabled ? "default" : "outline"}
                                className="h-7 gap-1.5 px-2 text-[10px]"
                                disabled={!mediaSupport.getDisplayMedia}
                                onClick={() => void setLocalScreenEnabled(!localScreenEnabled)}
                            >
                                {localScreenEnabled ? <MonitorUp className="h-3 w-3" /> : <MonitorX className="h-3 w-3" />}
                                {localScreenEnabled ? "Sharing" : "Share"}
                            </Button>
                        </div>
                        {/* {showMediaHelp && (
                            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-200">
                                Media permissions/runtime need attention. Request permissions, then restart PGStudio if camera/mic/screen are still unavailable.
                                {permissionEntries.length > 0 && (
                                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                                        {permissionEntries.map((entry) => (
                                            <div
                                                key={entry.key}
                                                className={cn("rounded-md border px-1.5 py-1 text-center", permissionStateBadgeClass(entry.state))}
                                            >
                                                <p className="text-[9px] uppercase tracking-wide opacity-80">{entry.label}</p>
                                                <p className="text-[10px] font-semibold">{permissionStateLabel(entry.state)}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 border-amber-500/35 text-[10px]"
                                        onClick={() => void handleRequestAllPermissions()}
                                        disabled={requestingPermissions}
                                    >
                                        {requestingPermissions ? "Requesting..." : "Request all permissions"}
                                    </Button>
                                    {!mediaSupport.getUserMedia && (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-6 border-amber-500/35 text-[10px]"
                                                onClick={() => void handleOpenPermissionSettings("camera")}
                                            >
                                                Open Camera settings
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-6 border-amber-500/35 text-[10px]"
                                                onClick={() => void handleOpenPermissionSettings("microphone")}
                                            >
                                                Open Microphone settings
                                            </Button>
                                        </>
                                    )}
                                    {!mediaSupport.getDisplayMedia && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-6 border-amber-500/35 text-[10px]"
                                            onClick={() => void handleOpenPermissionSettings("screen")}
                                        >
                                            Open Screen Capture settings
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )} */}
                        {mediaTiles.length > 0 && (
                            <ScrollArea className="w-full">
                                <div className="flex gap-2 pb-1">
                                    {mediaTiles.map((tile) => (
                                        <VideoBubble
                                            key={tile.id}
                                            title={tile.title}
                                            subtitle={tile.subtitle}
                                            stream={tile.stream}
                                            color={tile.color}
                                            onClick={() => setExpandedMedia(tile)}
                                        />
                                    ))}
                                </div>
                            </ScrollArea>
                        )}
                    </div>

                    {expandedMedia && (
                        <MediaPreviewDialog tile={expandedMedia} onClose={() => setExpandedMedia(null)} />
                    )}

                    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="min-h-0 border-b border-border/20 px-3 py-2">
                            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
                                <Users className="h-3.5 w-3.5" /> Participants
                            </div>
                            <ScrollArea className="h-[210px] pr-1">
                                <div className="space-y-1.5">
                                    {visibleParticipants.map((participant) => (
                                        <ParticipantRow
                                            key={participant.id}
                                            participant={participant}
                                            isHost={localAccessLevel === "host"}
                                            localUserId={localUserId}
                                            onAccessChange={(userId, accessLevel) => {
                                                void setParticipantAccess(userId, accessLevel);
                                            }}
                                        />
                                    ))}
                                    {hiddenParticipantCount > 0 && (
                                        <div className="px-1 text-[10px] text-muted-foreground/70">
                                            +{hiddenParticipantCount} more participants
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </div>

                        <div className="flex min-h-0 flex-col px-3 py-2">
                            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
                                <MessageSquare className="h-3.5 w-3.5" /> Session chat
                            </div>
                            <ScrollArea className="min-h-0 flex-1 pr-1">
                                <div className="space-y-1.5">
                                    {chatMessages.map((message) => {
                                        const color = getCollaborationColor(message.colorIndex);
                                        return (
                                            <div key={message.id} className="rounded-md border border-border/20 bg-background/20 px-2 py-1.5">
                                                <div className="mb-0.5 flex items-center justify-between gap-2">
                                                    <span className="truncate text-[10px] font-semibold" style={{ color }}>{message.userName}</span>
                                                    <span className="text-[9px] text-muted-foreground/60">
                                                        {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                                    </span>
                                                </div>
                                                <p className="break-words text-[11px] text-foreground/85">{message.text}</p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </ScrollArea>
                            <div className="mt-2 flex gap-1.5">
                                <Input
                                    value={chatInput}
                                    onChange={(e) => setChatInput(e.target.value)}
                                    placeholder="Type a message"
                                    className="h-8 text-xs"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            void handleSendChat();
                                        }
                                    }}
                                />
                                <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={handleSendChat}>
                                    <Send className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </aside>
    );
}
