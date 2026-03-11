"use client";

import { create } from "zustand";
import { toast } from "sonner";
import { getFirebaseConfig } from "@/lib/firebase";
import { playNotificationSound } from "@/lib/notification-sound";
import { useAuthStore } from "@/stores/auth-store";
import { useIdeFsStore, computeWorkspaceFingerprint } from "@/stores/ide-fs-store";
import { getCollaboratorColor, getColorIndexFromUserId, getInitials } from "@/lib/collaboration/palette";
import { WebRtcMesh } from "@/lib/collaboration/webrtc-mesh";
import type { QueryResult } from "@/lib/types";
import type { FsNode } from "@/stores/ide-fs-store";
import type {
    CollaborationAccessLevel,
    CollaborationChatMessage,
    CollaborationCursor,
    CollaborationDocSnapshot,
    CollaborationParticipant,
    CollaborationQueryResultSnapshot,
    CollaborationRemoteMedia,
    CollaborationStatus,
    WebRtcSignal,
    WorkspaceSnapshot,
} from "@/lib/collaboration/types";

type Database = import("firebase/database").Database;
type DatabaseModule = typeof import("firebase/database");
type AppModule = typeof import("firebase/app");

const LOG = "[Collaboration]";
const ROOM_ROOT = "collabRooms";
const MAX_CHAT_MESSAGES = 250;
const CURSOR_THROTTLE_MS = 90;
const DOC_THROTTLE_MS = 120;
const WORKSPACE_SYNC_INTERVAL_MS = 2500;
const WORKSPACE_SYNC_DEBOUNCE_MS = 220;
const WORKSPACE_STATE_DEBOUNCE_MS = 240;
const WORKSPACE_NODE_RETRY_MS = 1200;
const JOIN_TOAST_WINDOW_MS = 650;
const HEARTBEAT_MS = 12_000;
const MEDIA_STAGE_LIMIT = 12;
const QUERY_RESULT_PREVIEW_ROWS = 200;
const QUERY_RESULT_PREVIEW_COLUMNS = 60;
const DEFAULT_WEB_BASE = process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app";
const GUEST_ID_KEY = "pgstudio_collab_guest_id";
const INSTANCE_ID_KEY = "pgstudio_collab_instance_id";

interface Identity {
    userId: string;
    accountId: string;
    displayName: string;
    avatar: string | null;
    initials: string;
    colorIndex: number;
}

interface ParticipantRecord {
    id?: string;
    accountId?: string;
    name?: string;
    avatar?: string | null;
    colorIndex?: number;
    accessLevel?: CollaborationAccessLevel;
    joinedAt?: number;
    lastSeen?: number;
    activeDocKey?: string | null;
    cursor?: CollaborationCursor | null;
    micEnabled?: boolean;
    cameraEnabled?: boolean;
    screenEnabled?: boolean;
}

interface PermissionRecord {
    level?: CollaborationAccessLevel;
    updatedAt?: number;
    updatedBy?: string;
}

interface QueryResultRecord {
    docKey?: string;
    sql?: string;
    tabTitle?: string;
    result?: QueryResult | null;
    truncated?: boolean;
    previewRows?: number;
    updatedBy?: string;
    updatedByName?: string;
    updatedAt?: number;
}

interface WorkspaceNodeRecord {
    id: string;
    name: string;
    type: "file" | "folder";
    content: string;
    parentId: string | null;
    order: number;
    createdAt: number;
    updatedAt: number;
    updatedBy: string;
}

interface WorkspaceStateRecord {
    activeFileId: string | null;
    expandedIds: string[];
    updatedAt: number;
    updatedBy: string;
}

interface RuntimeState {
    appModule: AppModule | null;
    dbModule: DatabaseModule | null;
    db: Database | null;
    roomId: string | null;
    localUserId: string | null;
    localAccountId: string | null;
    participantRefPath: string | null;
    unsubs: Array<() => void>;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    workspaceTimer: ReturnType<typeof setInterval> | null;
    pendingWorkspaceSyncTimer: ReturnType<typeof setTimeout> | null;
    pendingWorkspaceStateTimer: ReturnType<typeof setTimeout> | null;
    pendingWorkspaceNodeChanges: Record<string, WorkspaceNodeRecord | null>;
    pendingDocTimers: Record<string, ReturnType<typeof setTimeout>>;
    lastCursorEmitAt: number;
    suppressWorkspaceUploadUntil: number;
    lastWorkspaceFingerprint: string;
    lastWorkspaceStateFingerprint: string;
    mesh: WebRtcMesh | null;
    localAudioTrack: MediaStreamTrack | null;
    localCameraTrack: MediaStreamTrack | null;
    localScreenTrack: MediaStreamTrack | null;
    localCameraStream: MediaStream | null;
    localScreenStream: MediaStream | null;
    remoteMedia: Record<string, CollaborationRemoteMedia>;
    participantCache: Record<string, CollaborationParticipant>;
    participantRecordCache: Record<string, ParticipantRecord>;
    cursorCacheByDoc: Record<string, Record<string, CollaborationParticipant>>;
    participantsReady: boolean;
    chatReady: boolean;
    seenChatIds: Set<string>;
    seenParticipantIds: Set<string>;
    joinToastNames: string[];
    joinToastTimer: ReturnType<typeof setTimeout> | null;
    workspaceMutedNodes: Map<string, number>;
    pendingJoinRoomId: string | null;
}

const runtime: RuntimeState = {
    appModule: null,
    dbModule: null,
    db: null,
    roomId: null,
    localUserId: null,
    localAccountId: null,
    participantRefPath: null,
    unsubs: [],
    heartbeatTimer: null,
    workspaceTimer: null,
    pendingWorkspaceSyncTimer: null,
    pendingWorkspaceStateTimer: null,
    pendingWorkspaceNodeChanges: {},
    pendingDocTimers: {},
    lastCursorEmitAt: 0,
    suppressWorkspaceUploadUntil: 0,
    lastWorkspaceFingerprint: "",
    lastWorkspaceStateFingerprint: "",
    mesh: null,
    localAudioTrack: null,
    localCameraTrack: null,
    localScreenTrack: null,
    localCameraStream: null,
    localScreenStream: null,
    remoteMedia: {},
    participantCache: {},
    participantRecordCache: {},
    cursorCacheByDoc: {},
    participantsReady: false,
    chatReady: false,
    seenChatIds: new Set<string>(),
    seenParticipantIds: new Set<string>(),
    joinToastNames: [],
    joinToastTimer: null,
    workspaceMutedNodes: new Map<string, number>(),
    pendingJoinRoomId: null,
};

function debug(message: string, details?: unknown) {
    if (process.env.NODE_ENV !== "production") {
        if (details !== undefined) {
            console.log(`${LOG} ${message}`, details);
        } else {
            console.log(`${LOG} ${message}`);
        }
    }
}

function buildShareUrl(roomId: string): string {
    const base = DEFAULT_WEB_BASE.replace(/\/$/, "");
    return `${base}/collab/${encodeURIComponent(roomId)}`;
}

function clampRoomId(input: string): string {
    return input.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
}

function createRoomId(): string {
    return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getGuestIdentity(): Identity {
    const fallbackId = `guest-${Math.random().toString(36).slice(2, 10)}`;
    let guestId = fallbackId;
    if (typeof window !== "undefined") {
        const existing = localStorage.getItem(GUEST_ID_KEY);
        if (existing) {
            guestId = existing;
        } else {
            localStorage.setItem(GUEST_ID_KEY, fallbackId);
        }
    }

    const participantId = composeParticipantId(guestId);
    const guestNumber = guestId.replace("guest-", "").slice(0, 4).toUpperCase();
    const displayName = `Guest ${guestNumber}`;
    return {
        userId: participantId,
        accountId: guestId,
        displayName,
        avatar: null,
        initials: getInitials(displayName),
        colorIndex: getColorIndexFromUserId(participantId),
    };
}

function getIdentityFromAuth(): Identity {
    const user = useAuthStore.getState().user;
    if (!user?.id) return getGuestIdentity();
    const accountId = user.id;
    const participantId = composeParticipantId(accountId);
    const displayName = (user.name || user.email || "User").trim();
    return {
        userId: participantId,
        accountId,
        displayName,
        avatar: user.image ?? null,
        initials: getInitials(displayName),
        colorIndex: getColorIndexFromUserId(participantId),
    };
}

function getOrCreateInstanceId(): string {
    if (typeof window === "undefined") {
        return Math.random().toString(36).slice(2, 8);
    }
    const existing = sessionStorage.getItem(INSTANCE_ID_KEY);
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem(INSTANCE_ID_KEY, created);
    return created;
}

function composeParticipantId(accountId: string): string {
    const instanceId = getOrCreateInstanceId();
    return `${accountId}-${instanceId}`;
}

function ensureParticipant(record: ParticipantRecord | null | undefined, userId: string, isLocal: boolean): CollaborationParticipant {
    const name = (record?.name ?? "User").trim() || "User";
    const colorIndex = Number.isFinite(record?.colorIndex) ? Math.max(0, Number(record?.colorIndex)) : getColorIndexFromUserId(userId);
    return {
        id: userId,
        name,
        avatar: record?.avatar ?? null,
        initials: getInitials(name),
        colorIndex,
        accessLevel: record?.accessLevel ?? "view",
        joinedAt: record?.joinedAt ?? Date.now(),
        lastSeen: record?.lastSeen ?? Date.now(),
        activeDocKey: record?.activeDocKey ?? null,
        cursor: record?.cursor ?? null,
        micEnabled: Boolean(record?.micEnabled),
        cameraEnabled: Boolean(record?.cameraEnabled),
        screenEnabled: Boolean(record?.screenEnabled),
        isLocal,
    };
}

function canEdit(accessLevel: CollaborationAccessLevel | null): boolean {
    return accessLevel === "edit" || accessLevel === "delete" || accessLevel === "host";
}

function canDelete(accessLevel: CollaborationAccessLevel | null): boolean {
    return accessLevel === "delete" || accessLevel === "host";
}

async function ensureDb(): Promise<{ db: Database; dbModule: DatabaseModule }> {
    if (runtime.db && runtime.dbModule) {
        return { db: runtime.db, dbModule: runtime.dbModule };
    }

    const config = getFirebaseConfig();
    if (!config?.databaseURL) {
        throw new Error("Firebase Realtime Database is not configured.");
    }

    const [appModule, dbModule] = await Promise.all([
        import("firebase/app"),
        import("firebase/database"),
    ]);

    runtime.appModule = appModule;
    runtime.dbModule = dbModule;

    const app = appModule.getApps().length > 0
        ? appModule.getApp()
        : appModule.initializeApp(config);

    runtime.db = dbModule.getDatabase(app);
    return { db: runtime.db, dbModule };
}

function stopMediaTrack(track: MediaStreamTrack | null | undefined): void {
    if (!track) return;
    try {
        track.stop();
    } catch {
        // noop
    }
}

function getMediaDevices(): MediaDevices | null {
    if (typeof navigator === "undefined") return null;
    return navigator.mediaDevices ?? null;
}

function encodeFirebaseKey(value: string): string {
    return encodeURIComponent(value);
}

function decodeFirebaseKey(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function truncateQueryResultForSync(result: QueryResult): {
    result: QueryResult;
    truncated: boolean;
    previewRows: number;
} {
    if (result.is_error) {
        return {
            result,
            truncated: false,
            previewRows: 0,
        };
    }

    const truncatedColumns = result.columns.length > QUERY_RESULT_PREVIEW_COLUMNS;
    const truncatedRows = result.rows.length > QUERY_RESULT_PREVIEW_ROWS;
    if (!truncatedColumns && !truncatedRows) {
        return {
            result,
            truncated: false,
            previewRows: result.rows.length,
        };
    }

    const columns = result.columns.slice(0, QUERY_RESULT_PREVIEW_COLUMNS);
    const rows = result.rows
        .slice(0, QUERY_RESULT_PREVIEW_ROWS)
        .map((row) => row.slice(0, QUERY_RESULT_PREVIEW_COLUMNS));

    return {
        result: {
            ...result,
            columns,
            rows,
        },
        truncated: true,
        previewRows: rows.length,
    };
}

function buildWorkspaceNodePayload(node: FsNode, updatedBy: string): WorkspaceNodeRecord {
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        content: node.content,
        parentId: node.parentId ?? null,
        order: node.order,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        updatedBy,
    };
}

function getExpandedIdsForConnection(state: ReturnType<typeof useIdeFsStore.getState>, connectionId: string): string[] {
    const ids: string[] = [];
    for (const [id, expanded] of Object.entries(state.expandedIds)) {
        if (!expanded) continue;
        const node = state.nodes[id];
        if (node && node.connectionId === connectionId && node.type === "folder") {
            ids.push(id);
        }
    }
    ids.sort();
    return ids;
}

function computeWorkspaceStateFingerprint(activeFileId: string | null, expandedIds: string[]): string {
    return `${activeFileId ?? ""}::${expandedIds.join(",")}`;
}

function enqueueJoinToast(name: string): void {
    if (!name) return;
    runtime.joinToastNames.push(name);
    if (runtime.joinToastTimer) return;
    runtime.joinToastTimer = setTimeout(() => {
        const names = runtime.joinToastNames.splice(0);
        runtime.joinToastTimer = null;
        if (names.length === 0) return;
        const uniqueNames = Array.from(new Set(names)).slice(0, 6);
        let message: string;
        if (uniqueNames.length === 1) {
            message = `${uniqueNames[0]} joined the session`;
        } else if (uniqueNames.length <= 3) {
            message = `${uniqueNames.join(", ")} joined the session`;
        } else {
            const firstTwo = uniqueNames.slice(0, 2).join(", ");
            message = `${firstTwo} and ${uniqueNames.length - 2} others joined the session`;
        }
        playNotificationSound(0.22);
        toast(message, { duration: 3200 });
    }, JOIN_TOAST_WINDOW_MS);
}

function clearRuntime(): void {
    runtime.unsubs.forEach((unsub) => {
        try {
            unsub();
        } catch {
            // noop
        }
    });
    runtime.unsubs = [];

    if (runtime.heartbeatTimer) {
        clearInterval(runtime.heartbeatTimer);
        runtime.heartbeatTimer = null;
    }
    if (runtime.workspaceTimer) {
        clearInterval(runtime.workspaceTimer);
        runtime.workspaceTimer = null;
    }
    if (runtime.pendingWorkspaceSyncTimer) {
        clearTimeout(runtime.pendingWorkspaceSyncTimer);
        runtime.pendingWorkspaceSyncTimer = null;
    }
    if (runtime.pendingWorkspaceStateTimer) {
        clearTimeout(runtime.pendingWorkspaceStateTimer);
        runtime.pendingWorkspaceStateTimer = null;
    }

    Object.values(runtime.pendingDocTimers).forEach((timer) => clearTimeout(timer));
    runtime.pendingDocTimers = {};

    runtime.mesh?.disconnectAll();
    runtime.mesh = null;

    stopMediaTrack(runtime.localAudioTrack);
    stopMediaTrack(runtime.localCameraTrack);
    stopMediaTrack(runtime.localScreenTrack);
    runtime.localAudioTrack = null;
    runtime.localCameraTrack = null;
    runtime.localScreenTrack = null;
    runtime.localCameraStream = null;
    runtime.localScreenStream = null;

    runtime.remoteMedia = {};
    runtime.lastCursorEmitAt = 0;
    runtime.suppressWorkspaceUploadUntil = 0;
    runtime.lastWorkspaceFingerprint = "";
    runtime.lastWorkspaceStateFingerprint = "";
    runtime.pendingWorkspaceNodeChanges = {};
    runtime.workspaceMutedNodes = new Map<string, number>();
    runtime.participantCache = {};
    runtime.participantRecordCache = {};
    runtime.cursorCacheByDoc = {};
    runtime.participantsReady = false;
    runtime.chatReady = false;
    runtime.seenChatIds = new Set<string>();
    runtime.seenParticipantIds = new Set<string>();
    if (runtime.joinToastTimer) {
        clearTimeout(runtime.joinToastTimer);
        runtime.joinToastTimer = null;
    }
    runtime.joinToastNames = [];
    runtime.roomId = null;
    runtime.localUserId = null;
    runtime.localAccountId = null;
    runtime.participantRefPath = null;
}

interface CollaborationStore {
    status: CollaborationStatus;
    roomId: string | null;
    shareUrl: string | null;
    error: string | null;

    connectionContextId: string | null;
    pendingJoinRoomId: string | null;

    hostId: string | null;
    hostAccountId: string | null;
    localUserId: string | null;
    localUserName: string | null;

    participants: Record<string, CollaborationParticipant>;
    permissions: Record<string, CollaborationAccessLevel>;
    chatMessages: CollaborationChatMessage[];
    docs: Record<string, CollaborationDocSnapshot>;
    queryResults: Record<string, CollaborationQueryResultSnapshot>;
    remoteCursorsByDoc: Record<string, CollaborationParticipant[]>;

    localAccessLevel: CollaborationAccessLevel | null;

    localMicEnabled: boolean;
    localCameraEnabled: boolean;
    localScreenEnabled: boolean;
    localCameraStream: MediaStream | null;
    localScreenStream: MediaStream | null;

    remoteMedia: Record<string, CollaborationRemoteMedia>;

    setConnectionContext: (connectionId: string | null) => void;

    createRoom: (connectionId: string | null) => Promise<void>;
    joinRoom: (roomId: string, connectionId: string | null) => Promise<void>;
    leaveRoom: () => Promise<void>;

    enqueueDeepLinkJoin: (roomId: string) => void;
    handleDeepLinkUrl: (url: string) => void;

    sendChatMessage: (text: string) => Promise<void>;
    setParticipantAccess: (userId: string, accessLevel: CollaborationAccessLevel) => Promise<void>;

    setActiveDocKey: (docKey: string | null) => Promise<void>;
    publishCursor: (docKey: string, cursor: Omit<CollaborationCursor, "updatedAt">) => Promise<void>;
    publishDocument: (docKey: string, content: string) => Promise<void>;
    publishQueryResult: (docKey: string, sql: string, tabTitle: string, result: QueryResult) => Promise<void>;

    setLocalMicEnabled: (enabled: boolean) => Promise<void>;
    setLocalCameraEnabled: (enabled: boolean) => Promise<void>;
    setLocalScreenEnabled: (enabled: boolean) => Promise<void>;
}

function computeAccessLevel(
    hostId: string | null,
    hostAccountId: string | null,
    localUserId: string | null,
    localAccountId: string | null,
    permissions: Record<string, CollaborationAccessLevel>
): CollaborationAccessLevel | null {
    if (!localUserId) return null;
    if (hostId && hostId === localUserId) return "host";
    if (hostAccountId && localAccountId && hostAccountId === localAccountId) return "host";
    return permissions[localUserId] ?? "view";
}

async function publishParticipantPatch(patch: Partial<ParticipantRecord>): Promise<void> {
    if (!runtime.db || !runtime.dbModule || !runtime.participantRefPath) return;
    await runtime.dbModule.update(runtime.dbModule.ref(runtime.db, runtime.participantRefPath), patch);
}

async function publishWorkspaceSnapshot(connectionId: string | null, force = false): Promise<void> {
    if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId || !connectionId) return;
    if (!force && Date.now() < runtime.suppressWorkspaceUploadUntil) return;

    const state = useIdeFsStore.getState();
    const snapshot = state.getConnectionWorkspaceSnapshot(connectionId);
    if (!force && snapshot.fingerprint === runtime.lastWorkspaceFingerprint) return;

    runtime.lastWorkspaceFingerprint = snapshot.fingerprint;
    runtime.lastWorkspaceStateFingerprint = computeWorkspaceStateFingerprint(snapshot.activeFileId, snapshot.expandedIds);
    runtime.pendingWorkspaceNodeChanges = {};
    if (runtime.pendingWorkspaceSyncTimer) {
        clearTimeout(runtime.pendingWorkspaceSyncTimer);
        runtime.pendingWorkspaceSyncTimer = null;
    }

    const payload: WorkspaceSnapshot = {
        ...snapshot,
        updatedBy: runtime.localUserId,
        updatedAt: Date.now(),
    };

    const nodes: Record<string, WorkspaceNodeRecord> = {};
    for (const node of Object.values(snapshot.nodes)) {
        nodes[node.id] = buildWorkspaceNodePayload(node, runtime.localUserId);
    }

    const statePayload: WorkspaceStateRecord = {
        activeFileId: snapshot.activeFileId,
        expandedIds: snapshot.expandedIds,
        updatedAt: Date.now(),
        updatedBy: runtime.localUserId,
    };

    await Promise.all([
        runtime.dbModule.set(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/workspaceNodes`),
            nodes
        ),
        runtime.dbModule.set(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/workspaceState`),
            statePayload
        ),
        runtime.dbModule.set(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/workspace`),
            payload
        ),
    ]);
}

async function flushWorkspaceNodeChanges(connectionId: string | null): Promise<void> {
    if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId || !connectionId) return;
    if (!canEdit(useCollaborationStore.getState().localAccessLevel)) return;
    if (Date.now() < runtime.suppressWorkspaceUploadUntil) return;

    const patch = runtime.pendingWorkspaceNodeChanges;
    if (!patch || Object.keys(patch).length === 0) return;
    const patchCopy = { ...patch };
    runtime.pendingWorkspaceNodeChanges = {};

    try {
        await runtime.dbModule.update(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/workspaceNodes`),
            patchCopy
        );
        const nextFingerprint = useIdeFsStore.getState().getConnectionSyncFingerprint(connectionId);
        runtime.lastWorkspaceFingerprint = nextFingerprint;
    } catch (error) {
        runtime.pendingWorkspaceNodeChanges = { ...patchCopy, ...runtime.pendingWorkspaceNodeChanges };
        console.warn(`${LOG} workspace node sync failed`, error);
        setTimeout(() => {
            void flushWorkspaceNodeChanges(connectionId);
        }, WORKSPACE_NODE_RETRY_MS);
    }
}

async function flushWorkspaceState(connectionId: string | null): Promise<void> {
    if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId || !connectionId) return;
    if (!canEdit(useCollaborationStore.getState().localAccessLevel)) return;
    if (Date.now() < runtime.suppressWorkspaceUploadUntil) return;

    const state = useIdeFsStore.getState();
    const expandedIds = getExpandedIdsForConnection(state, connectionId);
    const activeFileId = state.getActiveFile(connectionId);
    const fingerprint = computeWorkspaceStateFingerprint(activeFileId, expandedIds);
    if (fingerprint === runtime.lastWorkspaceStateFingerprint) return;

    runtime.lastWorkspaceStateFingerprint = fingerprint;
    const payload: WorkspaceStateRecord = {
        activeFileId,
        expandedIds,
        updatedAt: Date.now(),
        updatedBy: runtime.localUserId,
    };

    try {
        await runtime.dbModule.set(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/workspaceState`),
            payload
        );
    } catch (error) {
        runtime.lastWorkspaceStateFingerprint = "";
        console.warn(`${LOG} workspace state sync failed`, error);
    }
}

export const useCollaborationStore = create<CollaborationStore>((set, get) => ({
    status: "idle",
    roomId: null,
    shareUrl: null,
    error: null,

    connectionContextId: null,
    pendingJoinRoomId: null,

    hostId: null,
    hostAccountId: null,
    localUserId: null,
    localUserName: null,

    participants: {},
    permissions: {},
    chatMessages: [],
    docs: {},
    queryResults: {},
    remoteCursorsByDoc: {},

    localAccessLevel: null,

    localMicEnabled: false,
    localCameraEnabled: false,
    localScreenEnabled: false,
    localCameraStream: null,
    localScreenStream: null,

    remoteMedia: {},

    setConnectionContext: (connectionId) => {
        set({ connectionContextId: connectionId });
        if (connectionId && get().status === "connected" && canEdit(get().localAccessLevel)) {
            void publishWorkspaceSnapshot(connectionId);
        }
        const pending = runtime.pendingJoinRoomId;
        if (connectionId && pending && get().status === "idle") {
            runtime.pendingJoinRoomId = null;
            void get().joinRoom(pending, connectionId);
        }
    },

    createRoom: async (connectionId) => {
        const roomId = createRoomId();
        await get().joinRoom(roomId, connectionId);
    },

    joinRoom: async (roomIdInput, connectionId) => {
        const roomId = clampRoomId(roomIdInput);
        if (!roomId) {
            set({ error: "Invalid room id", status: "error" });
            return;
        }

        if (!connectionId) {
            runtime.pendingJoinRoomId = roomId;
            set({ pendingJoinRoomId: roomId, error: "Open a database connection before joining a collaboration room." });
            return;
        }

        if (get().status === "connected" && get().roomId === roomId) return;

        await get().leaveRoom();

        set({
            status: "connecting",
            error: null,
            roomId,
            shareUrl: buildShareUrl(roomId),
            connectionContextId: connectionId,
            pendingJoinRoomId: null,
        });

        runtime.pendingJoinRoomId = null;

        try {
            const identity = getIdentityFromAuth();
            runtime.localUserId = identity.userId;
            runtime.localAccountId = identity.accountId;
            const { db, dbModule } = await ensureDb();
            runtime.db = db;
            runtime.dbModule = dbModule;
            runtime.roomId = roomId;

            const roomRoot = `${ROOM_ROOT}/${roomId}`;
            const roomMetaRef = dbModule.ref(db, `${roomRoot}/meta`);
            const permissionsRef = dbModule.ref(db, `${roomRoot}/permissions`);
            const participantsRef = dbModule.ref(db, `${roomRoot}/participants`);
            const docsRef = dbModule.ref(db, `${roomRoot}/docs`);
            const queryResultsRef = dbModule.ref(db, `${roomRoot}/queryResults`);
            const chatRef = dbModule.query(dbModule.ref(db, `${roomRoot}/chat`), dbModule.limitToLast(MAX_CHAT_MESSAGES));
            const workspaceRef = dbModule.ref(db, `${roomRoot}/workspace`);
            const workspaceNodesRef = dbModule.ref(db, `${roomRoot}/workspaceNodes`);
            const workspaceStateRef = dbModule.ref(db, `${roomRoot}/workspaceState`);
            const signalsRef = dbModule.ref(db, `${roomRoot}/signals/${identity.userId}`);
            const participantRef = dbModule.ref(db, `${roomRoot}/participants/${identity.userId}`);
            runtime.participantRefPath = `${roomRoot}/participants/${identity.userId}`;

            await dbModule.runTransaction(roomMetaRef, (meta) => {
                if (meta && typeof meta === "object") return meta;
                return {
                    hostId: identity.userId,
                    hostAccountId: identity.accountId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            });

            const metaSnapshot = await dbModule.get(roomMetaRef);
            const metaData = metaSnapshot.val() as { hostId?: string; hostAccountId?: string } | null;
            const hostId = metaData?.hostId ?? identity.userId;
            const hostAccountId =
                metaData?.hostAccountId ??
                (hostId === identity.userId ? identity.accountId : null);
            if (!metaData?.hostAccountId && hostId === identity.userId) {
                await dbModule.update(roomMetaRef, {
                    hostAccountId: identity.accountId,
                    updatedAt: Date.now(),
                });
            }

            const localPermission: CollaborationAccessLevel =
                hostId === identity.userId || (hostAccountId && hostAccountId === identity.accountId)
                    ? "host"
                    : "view";

            await dbModule.runTransaction(dbModule.ref(db, `${roomRoot}/permissions/${identity.userId}`), (existing) => {
                if (existing && typeof existing === "object" && (existing as PermissionRecord).level) {
                    return existing;
                }
                return {
                    level: localPermission,
                    updatedAt: Date.now(),
                    updatedBy: hostId,
                };
            });

            const now = Date.now();
            await dbModule.set(participantRef, {
                id: identity.userId,
                accountId: identity.accountId,
                name: identity.displayName,
                avatar: identity.avatar,
                colorIndex: identity.colorIndex,
                accessLevel: localPermission,
                joinedAt: now,
                lastSeen: now,
                activeDocKey: null,
                cursor: null,
                micEnabled: false,
                cameraEnabled: false,
                screenEnabled: false,
            } satisfies ParticipantRecord);

            const participantOnDisconnect = dbModule.onDisconnect(participantRef);
            await participantOnDisconnect.remove();

            runtime.unsubs.push(() => {
                void participantOnDisconnect.cancel();
            });

            set({
                localUserId: identity.userId,
                localUserName: identity.displayName,
                hostId,
                hostAccountId,
                status: "connected",
                localAccessLevel: computeAccessLevel(
                    hostId,
                    hostAccountId,
                    identity.userId,
                    identity.accountId,
                    { [identity.userId]: localPermission }
                ),
            });

            runtime.mesh = new WebRtcMesh({
                localUserId: identity.userId,
                onSignal: async (signal) => {
                    if (!runtime.db || !runtime.dbModule || !runtime.roomId) return;
                    const signalRef = runtime.dbModule.push(
                        runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/signals/${signal.to}`)
                    );
                    await runtime.dbModule.set(signalRef, signal);
                },
                onRemoteMedia: (media) => {
                    runtime.remoteMedia = {
                        ...runtime.remoteMedia,
                        [media.userId]: media,
                    };
                    set({ remoteMedia: { ...runtime.remoteMedia } });
                },
                onPeerState: (peerId, state) => {
                    debug(`peer ${peerId} -> ${state}`);
                    if (state === "failed") {
                        toast.error("Media connection degraded for a participant. Retrying in background.");
                    }
                },
                onError: (message) => {
                    debug(message);
                },
            });

            runtime.heartbeatTimer = setInterval(() => {
                void publishParticipantPatch({ lastSeen: Date.now() });
            }, HEARTBEAT_MS);

            runtime.workspaceTimer = setInterval(() => {
                const accessLevel = get().localAccessLevel;
                if (!canEdit(accessLevel)) return;
                const currentConnectionId = get().connectionContextId;
                void flushWorkspaceNodeChanges(currentConnectionId);
                void flushWorkspaceState(currentConnectionId);
            }, WORKSPACE_SYNC_INTERVAL_MS);

            const ideFsUnsub = useIdeFsStore.subscribe((state, previousState) => {
                const accessLevel = get().localAccessLevel;
                const currentConnectionId = get().connectionContextId;
                if (!currentConnectionId || !canEdit(accessLevel)) return;
                if (Date.now() < runtime.suppressWorkspaceUploadUntil) return;

                const previousFingerprint = computeWorkspaceFingerprint(previousState.nodes, currentConnectionId);
                const nextFingerprint = computeWorkspaceFingerprint(state.nodes, currentConnectionId);
                if (previousFingerprint !== nextFingerprint) {
                    const patch: Record<string, WorkspaceNodeRecord | null> = {};
                    for (const node of Object.values(state.nodes)) {
                        if (node.connectionId !== currentConnectionId) continue;
                        const mutedAt = runtime.workspaceMutedNodes.get(node.id);
                        if (mutedAt && mutedAt === node.updatedAt) {
                            runtime.workspaceMutedNodes.delete(node.id);
                            continue;
                        }
                        const prev = previousState.nodes[node.id];
                        if (!prev) {
                            patch[node.id] = buildWorkspaceNodePayload(node, runtime.localUserId ?? "unknown");
                            continue;
                        }
                        if (
                            prev.updatedAt !== node.updatedAt ||
                            prev.name !== node.name ||
                            prev.parentId !== node.parentId ||
                            prev.order !== node.order ||
                            prev.content !== node.content ||
                            prev.type !== node.type
                        ) {
                            patch[node.id] = buildWorkspaceNodePayload(node, runtime.localUserId ?? "unknown");
                        }
                    }
                    for (const prevNode of Object.values(previousState.nodes)) {
                        if (prevNode.connectionId !== currentConnectionId) continue;
                        if (state.nodes[prevNode.id]) continue;
                        const mutedAt = runtime.workspaceMutedNodes.get(prevNode.id);
                        if (typeof mutedAt === "number" && mutedAt < 0) {
                            runtime.workspaceMutedNodes.delete(prevNode.id);
                            continue;
                        }
                        runtime.workspaceMutedNodes.set(prevNode.id, -1);
                        patch[prevNode.id] = null;
                    }

                    if (Object.keys(patch).length > 0) {
                        runtime.pendingWorkspaceNodeChanges = {
                            ...runtime.pendingWorkspaceNodeChanges,
                            ...patch,
                        };
                        if (runtime.pendingWorkspaceSyncTimer) {
                            clearTimeout(runtime.pendingWorkspaceSyncTimer);
                        }
                        runtime.pendingWorkspaceSyncTimer = setTimeout(() => {
                            runtime.pendingWorkspaceSyncTimer = null;
                            void flushWorkspaceNodeChanges(currentConnectionId);
                        }, WORKSPACE_SYNC_DEBOUNCE_MS);
                    }
                }

                const expandedIds = getExpandedIdsForConnection(state, currentConnectionId);
                const activeFileId = state.getActiveFile(currentConnectionId);
                const stateFingerprint = computeWorkspaceStateFingerprint(activeFileId, expandedIds);
                if (stateFingerprint !== runtime.lastWorkspaceStateFingerprint) {
                    if (runtime.pendingWorkspaceStateTimer) {
                        clearTimeout(runtime.pendingWorkspaceStateTimer);
                    }
                    runtime.pendingWorkspaceStateTimer = setTimeout(() => {
                        runtime.pendingWorkspaceStateTimer = null;
                        void flushWorkspaceState(currentConnectionId);
                    }, WORKSPACE_STATE_DEBOUNCE_MS);
                }
            });

            const updateRemoteCursors = (docKeys: Set<string>) => {
                if (docKeys.size === 0) return;
                set((prev) => {
                    const next = { ...prev.remoteCursorsByDoc };
                    for (const docKey of docKeys) {
                        const map = runtime.cursorCacheByDoc[docKey];
                        if (map && Object.keys(map).length > 0) {
                            next[docKey] = Object.values(map);
                        } else {
                            delete next[docKey];
                        }
                    }
                    return { remoteCursorsByDoc: next };
                });
            };

            const updateMediaStage = async () => {
                if (!runtime.mesh) return;
                const localIdValue = get().localUserId;
                const participants = Object.values(runtime.participantCache);
                const stageParticipants = participants
                    .filter((p) => p.id !== localIdValue)
                    .sort((a, b) => {
                        const aScore = Number(a.screenEnabled) * 4 + Number(a.cameraEnabled) * 3 + Number(a.micEnabled) * 2;
                        const bScore = Number(b.screenEnabled) * 4 + Number(b.cameraEnabled) * 3 + Number(b.micEnabled) * 2;
                        if (aScore !== bScore) return bScore - aScore;
                        return a.joinedAt - b.joinedAt;
                    })
                    .slice(0, MEDIA_STAGE_LIMIT);

                const stageSet = new Set(stageParticipants.map((p) => p.id));

                await Promise.all(stageParticipants.map(async (participant) => {
                    await runtime.mesh?.connectPeer(participant.id, true);
                }));

                for (const peerId of runtime.mesh.getConnectedPeers()) {
                    if (!stageSet.has(peerId)) {
                        runtime.mesh.disconnectPeer(peerId);
                    }
                }
            };

            const buildParticipant = (participantId: string, record: ParticipantRecord): CollaborationParticipant => {
                const permissions = get().permissions;
                const currentHostId = get().hostId;
                const currentHostAccountId = get().hostAccountId;
                const localId = get().localUserId;
                const explicitAccess =
                    (currentHostId && participantId === currentHostId) ||
                        (record.accountId && currentHostAccountId && record.accountId === currentHostAccountId)
                        ? "host"
                        : (permissions[participantId] ?? record.accessLevel ?? "view");

                return ensureParticipant({
                    ...record,
                    accessLevel: explicitAccess,
                }, participantId, participantId === localId);
            };

            const upsertParticipant = (participantId: string, record: ParticipantRecord, notifyJoin: boolean) => {
                if (!record) return;
                const prev = runtime.participantCache[participantId];
                const participant = buildParticipant(participantId, record);
                runtime.participantCache[participantId] = participant;
                runtime.participantRecordCache[participantId] = record;

                const affectedDocs = new Set<string>();
                const prevDocKey = prev?.activeDocKey ?? null;
                const nextDocKey = participant.activeDocKey ?? null;
                const prevCursorVersion = prev?.cursor?.updatedAt ?? 0;
                const nextCursorVersion = participant.cursor?.updatedAt ?? 0;

                if (prevDocKey && prev?.cursor && prevDocKey !== nextDocKey) {
                    const map = runtime.cursorCacheByDoc[prevDocKey];
                    if (map) {
                        delete map[participantId];
                    }
                    affectedDocs.add(prevDocKey);
                }

                if (nextDocKey && participant.cursor && participantId !== get().localUserId) {
                    if (!runtime.cursorCacheByDoc[nextDocKey]) {
                        runtime.cursorCacheByDoc[nextDocKey] = {};
                    }
                    runtime.cursorCacheByDoc[nextDocKey][participantId] = participant;
                    affectedDocs.add(nextDocKey);
                } else if (prevDocKey && prev?.cursor && !participant.cursor) {
                    const map = runtime.cursorCacheByDoc[prevDocKey];
                    if (map) {
                        delete map[participantId];
                    }
                    affectedDocs.add(prevDocKey);
                }

                if (prevDocKey === nextDocKey && prevCursorVersion !== nextCursorVersion && prevDocKey) {
                    if (!runtime.cursorCacheByDoc[prevDocKey]) {
                        runtime.cursorCacheByDoc[prevDocKey] = {};
                    }
                    if (participant.cursor && participantId !== get().localUserId) {
                        runtime.cursorCacheByDoc[prevDocKey][participantId] = participant;
                    } else {
                        delete runtime.cursorCacheByDoc[prevDocKey][participantId];
                    }
                    affectedDocs.add(prevDocKey);
                }

                const mediaChanged =
                    !prev ||
                    prev.micEnabled !== participant.micEnabled ||
                    prev.cameraEnabled !== participant.cameraEnabled ||
                    prev.screenEnabled !== participant.screenEnabled;

                const identityChanged =
                    !prev ||
                    prev.name !== participant.name ||
                    prev.avatar !== participant.avatar ||
                    prev.colorIndex !== participant.colorIndex ||
                    prev.accessLevel !== participant.accessLevel ||
                    prev.activeDocKey !== participant.activeDocKey;

                if (identityChanged || mediaChanged) {
                    set((prevState) => ({
                        participants: {
                            ...prevState.participants,
                            [participantId]: participant,
                        },
                    }));
                }

                if (affectedDocs.size > 0) {
                    updateRemoteCursors(affectedDocs);
                }

                if (mediaChanged) {
                    void updateMediaStage();
                }

                if (notifyJoin && runtime.participantsReady && participantId !== get().localUserId) {
                    enqueueJoinToast(participant.name);
                }
            };

            const removeParticipant = (participantId: string) => {
                const prev = runtime.participantCache[participantId];
                if (!prev) return;
                delete runtime.participantCache[participantId];
                delete runtime.participantRecordCache[participantId];
                const affectedDocs = new Set<string>();
                if (prev.activeDocKey && prev.cursor) {
                    const map = runtime.cursorCacheByDoc[prev.activeDocKey];
                    if (map) {
                        delete map[participantId];
                    }
                    affectedDocs.add(prev.activeDocKey);
                }
                set((prevState) => {
                    const nextParticipants = { ...prevState.participants };
                    delete nextParticipants[participantId];
                    return { participants: nextParticipants };
                });
                if (affectedDocs.size > 0) {
                    updateRemoteCursors(affectedDocs);
                }
                runtime.mesh?.disconnectPeer(participantId);
                void updateMediaStage();
            };

            const initialParticipantsSnapshot = await dbModule.get(participantsRef);
            const initialRaw = (initialParticipantsSnapshot.val() ?? {}) as Record<string, ParticipantRecord>;
            runtime.participantCache = {};
            runtime.participantRecordCache = {};
            runtime.cursorCacheByDoc = {};

            for (const [participantId, record] of Object.entries(initialRaw)) {
                if (!record) continue;
                const participant = buildParticipant(participantId, record);
                runtime.participantCache[participantId] = participant;
                runtime.participantRecordCache[participantId] = record;
                if (participant.activeDocKey && participant.cursor && participantId !== get().localUserId) {
                    if (!runtime.cursorCacheByDoc[participant.activeDocKey]) {
                        runtime.cursorCacheByDoc[participant.activeDocKey] = {};
                    }
                    runtime.cursorCacheByDoc[participant.activeDocKey][participantId] = participant;
                }
            }

            const initialCursors: Record<string, CollaborationParticipant[]> = {};
            for (const [docKey, map] of Object.entries(runtime.cursorCacheByDoc)) {
                initialCursors[docKey] = Object.values(map);
            }

            set((prev) => ({
                participants: { ...runtime.participantCache },
                remoteCursorsByDoc: initialCursors,
                localAccessLevel: computeAccessLevel(
                    prev.hostId,
                    prev.hostAccountId,
                    prev.localUserId,
                    runtime.localAccountId,
                    prev.permissions
                ),
            }));

            runtime.seenParticipantIds = new Set(Object.keys(initialRaw));
            runtime.participantsReady = true;
            void updateMediaStage();

            const participantsAddedUnsub = dbModule.onChildAdded(participantsRef, (snapshot) => {
                const participantId = snapshot.key;
                if (!participantId) return;
                if (runtime.participantCache[participantId]) return;
                const record = snapshot.val() as ParticipantRecord | null;
                if (!record) return;
                upsertParticipant(participantId, record, true);
                runtime.seenParticipantIds.add(participantId);
            });

            const participantsChangedUnsub = dbModule.onChildChanged(participantsRef, (snapshot) => {
                const participantId = snapshot.key;
                if (!participantId) return;
                const record = snapshot.val() as ParticipantRecord | null;
                if (!record) return;
                const prevRecord = runtime.participantRecordCache[participantId];
                const onlyLastSeenChanged =
                    prevRecord &&
                    Object.keys(record).length === Object.keys(prevRecord).length &&
                    Object.entries(record).every(([key, value]) => {
                        if (key === "lastSeen") return true;
                        return (prevRecord as Record<string, unknown>)[key] === value;
                    });
                if (onlyLastSeenChanged) {
                    runtime.participantRecordCache[participantId] = record;
                    return;
                }
                upsertParticipant(participantId, record, false);
            });

            const participantsRemovedUnsub = dbModule.onChildRemoved(participantsRef, (snapshot) => {
                const participantId = snapshot.key;
                if (!participantId) return;
                removeParticipant(participantId);
                runtime.seenParticipantIds.delete(participantId);
            });

            const refreshParticipantAccessLevels = (
                nextPermissions: Record<string, CollaborationAccessLevel>,
                nextHostId: string | null,
                nextHostAccountId: string | null
            ) => {
                let changed = false;
                const updatedParticipants: Record<string, CollaborationParticipant> = { ...runtime.participantCache };
                for (const [participantId, participant] of Object.entries(runtime.participantCache)) {
                    const record = runtime.participantRecordCache[participantId];
                    if (!record) continue;
                    const explicitAccess =
                        (nextHostId && participantId === nextHostId) ||
                            (record.accountId && nextHostAccountId && record.accountId === nextHostAccountId)
                            ? "host"
                            : (nextPermissions[participantId] ?? record.accessLevel ?? "view");
                    if (participant.accessLevel !== explicitAccess) {
                        const nextParticipant = {
                            ...participant,
                            accessLevel: explicitAccess,
                        };
                        updatedParticipants[participantId] = nextParticipant;
                        runtime.participantCache[participantId] = nextParticipant;
                        changed = true;
                    }
                }
                if (changed) {
                    set({ participants: updatedParticipants });
                }
            };

            const permissionsUnsub = dbModule.onValue(permissionsRef, (snapshot) => {
                const raw = (snapshot.val() ?? {}) as Record<string, PermissionRecord>;
                const nextPermissions: Record<string, CollaborationAccessLevel> = {};
                for (const [userId, record] of Object.entries(raw)) {
                    const level = record?.level;
                    if (!level) continue;
                    nextPermissions[userId] = level;
                }

                const currentHostId = get().hostId;
                const currentHostAccountId = get().hostAccountId;
                refreshParticipantAccessLevels(nextPermissions, currentHostId, currentHostAccountId);

                set((prev) => ({
                    permissions: nextPermissions,
                    localAccessLevel: computeAccessLevel(
                        prev.hostId,
                        prev.hostAccountId,
                        prev.localUserId,
                        runtime.localAccountId,
                        nextPermissions
                    ),
                }));
            });

            const metaUnsub = dbModule.onValue(roomMetaRef, (snapshot) => {
                const meta = snapshot.val() as { hostId?: string; hostAccountId?: string } | null;
                const nextHostId = meta?.hostId ?? null;
                const nextHostAccountId = meta?.hostAccountId ?? null;
                refreshParticipantAccessLevels(get().permissions, nextHostId, nextHostAccountId);
                set((prev) => ({
                    hostId: nextHostId,
                    hostAccountId: nextHostAccountId,
                    localAccessLevel: computeAccessLevel(
                        nextHostId,
                        nextHostAccountId,
                        prev.localUserId,
                        runtime.localAccountId,
                        prev.permissions
                    ),
                }));
            });

            const docsUnsub = dbModule.onValue(docsRef, (snapshot) => {
                const raw = (snapshot.val() ?? {}) as Record<string, { content?: string; updatedBy?: string; updatedAt?: number }>;
                set((prev) => {
                    const nextDocs: Record<string, CollaborationDocSnapshot> = { ...prev.docs };
                    for (const [docKey, doc] of Object.entries(raw)) {
                        const content = doc?.content ?? "";
                        const updatedBy = doc?.updatedBy ?? "unknown";
                        const updatedAt = doc?.updatedAt ?? Date.now();
                        const existing = prev.docs[docKey];
                        const version = existing ? existing.version + 1 : 1;
                        if (existing && existing.content === content && existing.updatedBy === updatedBy && existing.updatedAt === updatedAt) {
                            continue;
                        }
                        nextDocs[docKey] = {
                            content,
                            updatedBy,
                            updatedAt,
                            version,
                        };
                    }

                    for (const existingKey of Object.keys(nextDocs)) {
                        if (!Object.prototype.hasOwnProperty.call(raw, existingKey)) {
                            delete nextDocs[existingKey];
                        }
                    }

                    return { docs: nextDocs };
                });
            });

            const queryResultsUnsub = dbModule.onValue(queryResultsRef, (snapshot) => {
                const raw = (snapshot.val() ?? {}) as Record<string, QueryResultRecord>;
                const nextQueryResults: Record<string, CollaborationQueryResultSnapshot> = {};

                for (const [encodedDocKey, value] of Object.entries(raw)) {
                    if (!value || !value.result) continue;
                    const docKey = (value.docKey ?? decodeFirebaseKey(encodedDocKey)).trim();
                    if (!docKey) continue;

                    nextQueryResults[docKey] = {
                        docKey,
                        sql: value.sql ?? "",
                        tabTitle: value.tabTitle ?? "Query",
                        result: value.result,
                        truncated: Boolean(value.truncated),
                        previewRows: Number.isFinite(value.previewRows) ? Number(value.previewRows) : (value.result.rows?.length ?? 0),
                        updatedBy: value.updatedBy ?? "unknown",
                        updatedByName: value.updatedByName ?? "Participant",
                        updatedAt: Number(value.updatedAt ?? Date.now()),
                    };
                }

                set({ queryResults: nextQueryResults });
            });

            const chatUnsub = dbModule.onValue(chatRef, (snapshot) => {
                const raw = (snapshot.val() ?? {}) as Record<string, Omit<CollaborationChatMessage, "id"> & { id?: string }>;
                const messages = Object.entries(raw)
                    .map(([id, value]) => ({
                        id: value.id ?? id,
                        userId: value.userId,
                        userName: value.userName,
                        userAvatar: value.userAvatar ?? null,
                        colorIndex: Number.isFinite(value.colorIndex) ? value.colorIndex : getColorIndexFromUserId(value.userId),
                        text: value.text,
                        createdAt: Number(value.createdAt ?? Date.now()),
                    }))
                    .sort((a, b) => a.createdAt - b.createdAt)
                    .slice(-MAX_CHAT_MESSAGES);
                const incoming = messages.filter((msg) => !runtime.seenChatIds.has(msg.id));
                runtime.seenChatIds = new Set(messages.map((msg) => msg.id));
                set({ chatMessages: messages });

                if (!runtime.chatReady) {
                    runtime.chatReady = true;
                    return;
                }

                const remoteIncoming = incoming.filter((msg) => msg.userId !== runtime.localUserId);
                if (remoteIncoming.length === 0) return;
                playNotificationSound(0.2);
                for (const msg of remoteIncoming) {
                    const preview = msg.text.length > 140 ? `${msg.text.slice(0, 137)}…` : msg.text;
                    toast(`${msg.userName}: ${preview}`, { duration: 4500 });
                }
            });

            const initialWorkspaceNodesSnapshot = await dbModule.get(workspaceNodesRef);
            const initialWorkspaceStateSnapshot = await dbModule.get(workspaceStateRef);
            const initialNodesRaw = (initialWorkspaceNodesSnapshot.val() ?? {}) as Record<string, WorkspaceNodeRecord>;
            const initialStateRaw = initialWorkspaceStateSnapshot.val() as WorkspaceStateRecord | null;

            const currentConnectionId = get().connectionContextId;
            if (currentConnectionId) {
                if (Object.keys(initialNodesRaw).length > 0) {
                    const nodes: Record<string, FsNode> = {};
                    for (const record of Object.values(initialNodesRaw)) {
                        if (!record?.id) continue;
                        nodes[record.id] = {
                            id: record.id,
                            connectionId: currentConnectionId,
                            name: record.name ?? "untitled",
                            type: record.type ?? "file",
                            content: record.content ?? "",
                            parentId: record.parentId ?? null,
                            order: Number.isFinite(record.order) ? record.order : 0,
                            createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
                            updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
                        };
                    }
                    runtime.suppressWorkspaceUploadUntil = Date.now() + 900;
                    useIdeFsStore.getState().replaceConnectionWorkspace(currentConnectionId, {
                        nodes,
                        activeFileId: initialStateRaw?.activeFileId ?? null,
                        expandedIds: initialStateRaw?.expandedIds ?? [],
                    });
                    runtime.lastWorkspaceFingerprint = useIdeFsStore.getState().getConnectionSyncFingerprint(currentConnectionId);
                    runtime.lastWorkspaceStateFingerprint = computeWorkspaceStateFingerprint(
                        initialStateRaw?.activeFileId ?? null,
                        initialStateRaw?.expandedIds ?? []
                    );
                } else {
                    const legacySnapshot = await dbModule.get(workspaceRef);
                    const legacy = legacySnapshot.val() as WorkspaceSnapshot | null;
                    if (legacy?.nodes) {
                        runtime.suppressWorkspaceUploadUntil = Date.now() + 900;
                        useIdeFsStore.getState().replaceConnectionWorkspace(currentConnectionId, {
                            nodes: legacy.nodes,
                            activeFileId: legacy.activeFileId,
                            expandedIds: legacy.expandedIds,
                        });
                        runtime.lastWorkspaceFingerprint = legacy.fingerprint;
                        runtime.lastWorkspaceStateFingerprint = computeWorkspaceStateFingerprint(
                            legacy.activeFileId,
                            legacy.expandedIds
                        );
                    }
                    if (canEdit(get().localAccessLevel)) {
                        await publishWorkspaceSnapshot(currentConnectionId, true);
                    }
                }
            }

            const workspaceNodesAddedUnsub = dbModule.onChildAdded(workspaceNodesRef, (snapshot) => {
                const record = snapshot.val() as WorkspaceNodeRecord | null;
                if (!record || !record.id) return;
                if (record.updatedBy === runtime.localUserId) return;
                const connectionId = get().connectionContextId;
                if (!connectionId) return;
                runtime.workspaceMutedNodes.set(record.id, record.updatedAt);
                setTimeout(() => runtime.workspaceMutedNodes.delete(record.id), 5000);
                useIdeFsStore.getState().upsertNode(connectionId, {
                    id: record.id,
                    connectionId,
                    name: record.name ?? "untitled",
                    type: record.type ?? "file",
                    content: record.content ?? "",
                    parentId: record.parentId ?? null,
                    order: Number.isFinite(record.order) ? record.order : 0,
                    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
                    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
                });
            });

            const workspaceNodesChangedUnsub = dbModule.onChildChanged(workspaceNodesRef, (snapshot) => {
                const record = snapshot.val() as WorkspaceNodeRecord | null;
                if (!record || !record.id) return;
                if (record.updatedBy === runtime.localUserId) return;
                const connectionId = get().connectionContextId;
                if (!connectionId) return;
                runtime.workspaceMutedNodes.set(record.id, record.updatedAt);
                setTimeout(() => runtime.workspaceMutedNodes.delete(record.id), 5000);
                useIdeFsStore.getState().upsertNode(connectionId, {
                    id: record.id,
                    connectionId,
                    name: record.name ?? "untitled",
                    type: record.type ?? "file",
                    content: record.content ?? "",
                    parentId: record.parentId ?? null,
                    order: Number.isFinite(record.order) ? record.order : 0,
                    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
                    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
                });
            });

            const workspaceNodesRemovedUnsub = dbModule.onChildRemoved(workspaceNodesRef, (snapshot) => {
                const nodeId = snapshot.key;
                if (!nodeId) return;
                const mutedAt = runtime.workspaceMutedNodes.get(nodeId);
                if (mutedAt === -1) {
                    runtime.workspaceMutedNodes.delete(nodeId);
                    return;
                }
                const connectionId = get().connectionContextId;
                if (!connectionId) return;
                runtime.workspaceMutedNodes.set(nodeId, -2);
                useIdeFsStore.getState().removeNode(connectionId, nodeId);
            });

            const workspaceStateUnsub = dbModule.onValue(workspaceStateRef, (snapshot) => {
                const data = snapshot.val() as WorkspaceStateRecord | null;
                if (!data) return;
                if (data.updatedBy === runtime.localUserId) {
                    runtime.lastWorkspaceStateFingerprint = computeWorkspaceStateFingerprint(
                        data.activeFileId,
                        data.expandedIds ?? []
                    );
                    return;
                }
                const connectionId = get().connectionContextId;
                if (!connectionId) return;
                runtime.suppressWorkspaceUploadUntil = Date.now() + 800;
                runtime.lastWorkspaceStateFingerprint = computeWorkspaceStateFingerprint(
                    data.activeFileId,
                    data.expandedIds ?? []
                );
                useIdeFsStore.getState().applyWorkspaceState(connectionId, {
                    activeFileId: data.activeFileId ?? null,
                    expandedIds: data.expandedIds ?? [],
                });
            });

            const signalsUnsub = dbModule.onChildAdded(signalsRef, async (snapshot) => {
                const signal = snapshot.val() as WebRtcSignal | null;
                if (!signal || !runtime.mesh) {
                    await dbModule.remove(snapshot.ref);
                    return;
                }
                await runtime.mesh.handleSignal(signal);
                await dbModule.remove(snapshot.ref);
            });

            runtime.unsubs.push(
                participantsAddedUnsub,
                participantsChangedUnsub,
                participantsRemovedUnsub,
                permissionsUnsub,
                metaUnsub,
                docsUnsub,
                queryResultsUnsub,
                chatUnsub,
                workspaceNodesAddedUnsub,
                workspaceNodesChangedUnsub,
                workspaceNodesRemovedUnsub,
                workspaceStateUnsub,
                signalsUnsub,
                ideFsUnsub
            );

            if (canEdit(get().localAccessLevel)) {
                await publishWorkspaceSnapshot(connectionId);
            }
            toast.success("Collaboration session connected");
            debug(`joined room ${roomId}`);
        } catch (error) {
            console.error(`${LOG} join failed`, error);
            const message = error instanceof Error ? error.message : "Could not join collaboration room.";
            clearRuntime();
            set({
                status: "error",
                error: message,
                roomId: null,
                shareUrl: null,
                queryResults: {},
            });
            toast.error(message);
        }
    },

    leaveRoom: async () => {
        const roomId = runtime.roomId;
        const localUserId = runtime.localUserId;

        if (runtime.db && runtime.dbModule && roomId && localUserId) {
            try {
                await runtime.dbModule.remove(
                    runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${roomId}/participants/${localUserId}`)
                );
            } catch {
                // Ignore best-effort cleanup errors.
            }
        }

        clearRuntime();
        set({
            status: "idle",
            roomId: null,
            shareUrl: null,
            error: null,
            hostId: null,
            hostAccountId: null,
            participants: {},
            permissions: {},
            chatMessages: [],
            docs: {},
            queryResults: {},
            remoteCursorsByDoc: {},
            localAccessLevel: null,
            localMicEnabled: false,
            localCameraEnabled: false,
            localScreenEnabled: false,
            localCameraStream: null,
            localScreenStream: null,
            remoteMedia: {},
            localUserId: null,
            localUserName: null,
        });
    },

    enqueueDeepLinkJoin: (roomId) => {
        const normalized = clampRoomId(roomId);
        if (!normalized) return;
        runtime.pendingJoinRoomId = normalized;
        set({ pendingJoinRoomId: normalized });
    },

    handleDeepLinkUrl: (url) => {
        try {
            const parsed = new URL(url.replace("pgstudio://", "https://pgstudio.local/"));
            if (!parsed.pathname.includes("collab/join")) return;
            const room = clampRoomId(parsed.searchParams.get("room") ?? "");
            if (!room) return;
            const connectionId = get().connectionContextId;
            if (connectionId) {
                void get().joinRoom(room, connectionId);
            } else {
                runtime.pendingJoinRoomId = room;
                set({ pendingJoinRoomId: room });
                toast.info("Collaboration invite received. Connect to a database to join the room.");
            }
        } catch {
            // Ignore malformed deep links.
        }
    },

    sendChatMessage: async (text) => {
        const body = text.trim();
        if (!body) return;
        if (!runtime.db || !runtime.dbModule || !runtime.roomId) return;

        const identity = getIdentityFromAuth();
        const message: Omit<CollaborationChatMessage, "id"> = {
            userId: identity.userId,
            userName: identity.displayName,
            userAvatar: identity.avatar,
            colorIndex: identity.colorIndex,
            text: body.slice(0, 2000),
            createdAt: Date.now(),
        };

        const nextRef = runtime.dbModule.push(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/chat`)
        );

        await runtime.dbModule.set(nextRef, {
            ...message,
            id: nextRef.key,
        });
        playNotificationSound(0.18);
        toast.success("Message sent", { duration: 1800 });
    },

    setParticipantAccess: async (userId, accessLevel) => {
        if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId) return;
        const localAccess = get().localAccessLevel;
        if (localAccess !== "host") {
            toast.error("Only the host can change participant permissions.");
            return;
        }

        await runtime.dbModule.set(
            runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/permissions/${userId}`),
            {
                level: accessLevel,
                updatedAt: Date.now(),
                updatedBy: runtime.localUserId,
            }
        );
    },

    setActiveDocKey: async (docKey) => {
        if (!runtime.db || !runtime.dbModule || !runtime.participantRefPath) return;
        await publishParticipantPatch({
            activeDocKey: docKey,
            lastSeen: Date.now(),
        });
    },

    publishCursor: async (docKey, cursor) => {
        if (!runtime.db || !runtime.dbModule || !runtime.participantRefPath) return;
        const now = Date.now();
        if (now - runtime.lastCursorEmitAt < CURSOR_THROTTLE_MS) return;
        runtime.lastCursorEmitAt = now;

        await publishParticipantPatch({
            activeDocKey: docKey,
            cursor: {
                ...cursor,
                updatedAt: now,
            },
            lastSeen: now,
        });
    },

    publishDocument: async (docKey, content) => {
        if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId) return;
        if (!canEdit(get().localAccessLevel)) return;

        const existingTimer = runtime.pendingDocTimers[docKey];
        if (existingTimer) clearTimeout(existingTimer);

        runtime.pendingDocTimers[docKey] = setTimeout(async () => {
            if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId) return;
            try {
                await runtime.dbModule.set(
                    runtime.dbModule.ref(runtime.db, `${ROOM_ROOT}/${runtime.roomId}/docs/${docKey}`),
                    {
                        content,
                        updatedBy: runtime.localUserId,
                        updatedAt: Date.now(),
                    }
                );
            } finally {
                delete runtime.pendingDocTimers[docKey];
            }
        }, DOC_THROTTLE_MS);
    },

    publishQueryResult: async (docKey, sql, tabTitle, result) => {
        if (!runtime.db || !runtime.dbModule || !runtime.roomId || !runtime.localUserId) return;
        if (!canEdit(get().localAccessLevel)) return;
        const normalizedDocKey = docKey.trim();
        if (!normalizedDocKey) return;

        const { result: previewResult, truncated, previewRows } = truncateQueryResultForSync(result);
        const payload: QueryResultRecord = {
            docKey: normalizedDocKey,
            sql: sql.slice(0, 120_000),
            tabTitle: tabTitle.slice(0, 120),
            result: previewResult,
            truncated,
            previewRows,
            updatedBy: runtime.localUserId,
            updatedByName: get().localUserName ?? "Host",
            updatedAt: Date.now(),
        };

        await runtime.dbModule.set(
            runtime.dbModule.ref(
                runtime.db,
                `${ROOM_ROOT}/${runtime.roomId}/queryResults/${encodeFirebaseKey(normalizedDocKey)}`
            ),
            payload
        );
    },

    setLocalMicEnabled: async (enabled) => {
        if (!runtime.mesh) return;

        if (enabled) {
            const mediaDevices = getMediaDevices();
            if (!mediaDevices?.getUserMedia) {
                toast.error("Microphone is not available in this runtime.");
                set({ localMicEnabled: false });
                return;
            }
            try {
                const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
                const track = stream.getAudioTracks()[0] ?? null;
                runtime.localAudioTrack = track;
                if (track) {
                    track.onended = () => {
                        runtime.localAudioTrack = null;
                        set({ localMicEnabled: false });
                        void publishParticipantPatch({ micEnabled: false });
                    };
                }
                set({ localMicEnabled: Boolean(track) });
                await runtime.mesh.updateLocalTracks({ audio: track });
                await publishParticipantPatch({ micEnabled: Boolean(track) });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Microphone access denied.";
                toast.error(message);
                set({ localMicEnabled: false });
            }
            return;
        }

        stopMediaTrack(runtime.localAudioTrack);
        runtime.localAudioTrack = null;
        set({ localMicEnabled: false });
        await runtime.mesh.updateLocalTracks({ audio: null });
        await publishParticipantPatch({ micEnabled: false });
    },

    setLocalCameraEnabled: async (enabled) => {
        if (!runtime.mesh) return;

        if (enabled) {
            const mediaDevices = getMediaDevices();
            if (!mediaDevices?.getUserMedia) {
                toast.error("Camera is not available in this runtime.");
                set({ localCameraEnabled: false, localCameraStream: null });
                return;
            }
            try {
                const stream = await mediaDevices.getUserMedia({ video: true, audio: false });
                const track = stream.getVideoTracks()[0] ?? null;
                runtime.localCameraTrack = track;
                runtime.localCameraStream = track ? stream : null;
                if (track) {
                    track.onended = () => {
                        runtime.localCameraTrack = null;
                        runtime.localCameraStream = null;
                        set({ localCameraEnabled: false, localCameraStream: null });
                        void publishParticipantPatch({ cameraEnabled: false });
                    };
                }
                set({ localCameraEnabled: Boolean(track), localCameraStream: runtime.localCameraStream });
                await runtime.mesh.updateLocalTracks({ camera: track });
                await publishParticipantPatch({ cameraEnabled: Boolean(track) });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Camera access denied.";
                toast.error(message);
                set({ localCameraEnabled: false, localCameraStream: null });
            }
            return;
        }

        stopMediaTrack(runtime.localCameraTrack);
        runtime.localCameraTrack = null;
        runtime.localCameraStream = null;
        set({ localCameraEnabled: false, localCameraStream: null });
        await runtime.mesh.updateLocalTracks({ camera: null });
        await publishParticipantPatch({ cameraEnabled: false });
    },

    setLocalScreenEnabled: async (enabled) => {
        if (!runtime.mesh) return;

        if (enabled) {
            const mediaDevices = getMediaDevices();
            if (!mediaDevices?.getDisplayMedia) {
                toast.error("Screen sharing is not available in this runtime.");
                set({ localScreenEnabled: false, localScreenStream: null });
                return;
            }
            try {
                const stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
                const track = stream.getVideoTracks()[0] ?? null;
                runtime.localScreenTrack = track;
                runtime.localScreenStream = track ? stream : null;
                if (track) {
                    track.contentHint = "detail";
                    track.onended = () => {
                        runtime.localScreenTrack = null;
                        runtime.localScreenStream = null;
                        set({ localScreenEnabled: false, localScreenStream: null });
                        void runtime.mesh?.updateLocalTracks({ screen: null });
                        void publishParticipantPatch({ screenEnabled: false });
                    };
                }
                set({ localScreenEnabled: Boolean(track), localScreenStream: runtime.localScreenStream });
                await runtime.mesh.updateLocalTracks({ screen: track });
                await publishParticipantPatch({ screenEnabled: Boolean(track) });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Screen share permission was not granted.";
                toast.error(message);
                set({ localScreenEnabled: false, localScreenStream: null });
            }
            return;
        }

        stopMediaTrack(runtime.localScreenTrack);
        runtime.localScreenTrack = null;
        runtime.localScreenStream = null;
        set({ localScreenEnabled: false, localScreenStream: null });
        await runtime.mesh.updateLocalTracks({ screen: null });
        await publishParticipantPatch({ screenEnabled: false });
    },
}));

export function getCollaborationColor(index: number): string {
    return getCollaboratorColor(index);
}

export function getCollaborationPermissions(accessLevel: CollaborationAccessLevel | null): {
    canEdit: boolean;
    canDelete: boolean;
} {
    return {
        canEdit: canEdit(accessLevel),
        canDelete: canDelete(accessLevel),
    };
}
