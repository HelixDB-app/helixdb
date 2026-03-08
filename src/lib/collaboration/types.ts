import type { QueryResult } from "@/lib/types";

export type CollaborationStatus = "idle" | "connecting" | "connected" | "error";

export type CollaborationAccessLevel = "view" | "edit" | "delete" | "host";

export interface CollaborationSelection {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}

export interface CollaborationCursor {
    lineNumber: number;
    column: number;
    selection?: CollaborationSelection | null;
    updatedAt: number;
}

export interface CollaborationParticipant {
    id: string;
    name: string;
    avatar: string | null;
    initials: string;
    colorIndex: number;
    accessLevel: CollaborationAccessLevel;
    joinedAt: number;
    lastSeen: number;
    activeDocKey: string | null;
    cursor: CollaborationCursor | null;
    micEnabled: boolean;
    cameraEnabled: boolean;
    screenEnabled: boolean;
    isLocal: boolean;
}

export interface CollaborationChatMessage {
    id: string;
    userId: string;
    userName: string;
    userAvatar: string | null;
    colorIndex: number;
    text: string;
    createdAt: number;
}

export interface CollaborationDocSnapshot {
    content: string;
    updatedBy: string;
    updatedAt: number;
    version: number;
}

export interface CollaborationQueryResultSnapshot {
    docKey: string;
    sql: string;
    tabTitle: string;
    result: QueryResult;
    truncated: boolean;
    previewRows: number;
    updatedBy: string;
    updatedByName: string;
    updatedAt: number;
}

export interface WorkspaceSnapshot {
    fingerprint: string;
    activeFileId: string | null;
    expandedIds: string[];
    nodes: Record<string, {
        id: string;
        connectionId: string;
        name: string;
        type: "file" | "folder";
        content: string;
        parentId: string | null;
        order: number;
        createdAt: number;
        updatedAt: number;
    }>;
    updatedBy: string;
    updatedAt: number;
}

export interface WebRtcSignal {
    from: string;
    to: string;
    type: "offer" | "answer" | "ice" | "renegotiate";
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    createdAt: number;
}

export interface CollaborationMediaState {
    micEnabled: boolean;
    cameraEnabled: boolean;
    screenEnabled: boolean;
}

export interface CollaborationRemoteMedia {
    userId: string;
    cameraStream: MediaStream | null;
    screenStream: MediaStream | null;
    audioStream: MediaStream | null;
}
