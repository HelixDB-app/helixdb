import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NodeType = "file" | "folder";

export interface FsNode {
    id: string;
    connectionId: string;
    name: string;
    type: NodeType;
    content: string;
    parentId: string | null;
    order: number;
    createdAt: number;
    updatedAt: number;
}

export interface ConnectionWorkspaceSnapshot {
    fingerprint: string;
    activeFileId: string | null;
    expandedIds: string[];
    nodes: Record<string, FsNode>;
}

function genId(): string {
    return `fs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

interface IdeFsState {
    nodes: Record<string, FsNode>;
    /** folder ids that are expanded: Record<id, true> */
    expandedIds: Record<string, boolean>;
    /** active file per connectionId */
    activeFileByConnection: Record<string, string | null>;

    // Read helpers (not actions)
    getChildren: (connectionId: string, parentId: string | null) => FsNode[];
    getRootNodes: (connectionId: string) => FsNode[];
    getAncestorIds: (nodeId: string) => string[];

    // CRUD
    createNode: (connectionId: string, name: string, type: NodeType, parentId: string | null, content?: string) => FsNode;
    deleteNode: (id: string) => void;
    renameNode: (id: string, name: string) => void;
    updateContent: (id: string, content: string) => void;
    duplicateNode: (id: string) => void;
    moveNode: (id: string, newParentId: string | null) => void;

    // Folder expand/collapse
    toggleFolder: (id: string) => void;
    setExpanded: (id: string, expanded: boolean) => void;
    expandAll: (connectionId: string) => void;
    collapseAll: (connectionId: string) => void;

    // Active file
    setActiveFile: (connectionId: string, id: string | null) => void;
    getActiveFile: (connectionId: string) => string | null;

    // Project workspace auto-init
    ensureConnectionProject: (connectionId: string, databaseName: string) => void;

    // Path helpers for Git workspace sync
    getRelativePathForNode: (nodeId: string) => string | null;
    getAllFileEntries: (connectionId: string) => { path: string; content: string }[];
    getFileCount: (connectionId: string) => number;
    getConnectionSyncFingerprint: (connectionId: string) => string;
    getConnectionWorkspaceSnapshot: (connectionId: string) => ConnectionWorkspaceSnapshot;
    replaceConnectionWorkspace: (
        connectionId: string,
        snapshot: {
            nodes: Record<string, FsNode>;
            activeFileId: string | null;
            expandedIds?: string[];
        }
    ) => void;
}

export const useIdeFsStore = create<IdeFsState>()(
    persist(
        (set, get) => ({
            nodes: {},
            expandedIds: {},
            activeFileByConnection: {},

            getChildren: (connectionId, parentId) => {
                return Object.values(get().nodes)
                    .filter((n) => n.connectionId === connectionId && n.parentId === parentId)
                    .sort((a, b) => {
                        // Folders first, then alphabetically
                        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
                        return a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name);
                    });
            },

            getRootNodes: (connectionId) => get().getChildren(connectionId, null),

            getAncestorIds: (nodeId) => {
                const { nodes } = get();
                const ids: string[] = [];
                let current = nodes[nodeId];
                while (current?.parentId) {
                    ids.push(current.parentId);
                    current = nodes[current.parentId];
                }
                return ids;
            },

            createNode: (connectionId, name, type, parentId, content = "") => {
                const siblings = get().getChildren(connectionId, parentId);
                const maxOrder = siblings.reduce((max, n) => Math.max(max, n.order), -1);
                const node: FsNode = {
                    id: genId(),
                    connectionId,
                    name,
                    type,
                    content: type === "file" ? content : "",
                    parentId,
                    order: maxOrder + 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                set((s) => ({ nodes: { ...s.nodes, [node.id]: node } }));
                // Auto-expand parent
                if (parentId) {
                    set((s) => ({ expandedIds: { ...s.expandedIds, [parentId]: true } }));
                }
                return node;
            },

            deleteNode: (id) => {
                const { nodes } = get();
                // Collect all descendant ids
                const toDelete = new Set<string>();
                const queue = [id];
                while (queue.length > 0) {
                    const current = queue.pop()!;
                    toDelete.add(current);
                    for (const node of Object.values(nodes)) {
                        if (node.parentId === current) queue.push(node.id);
                    }
                }
                set((s) => {
                    const next = { ...s.nodes };
                    const expanded = { ...s.expandedIds };
                    const active = { ...s.activeFileByConnection };
                    toDelete.forEach((did) => {
                        delete next[did];
                        delete expanded[did];
                    });
                    // Clear active file if deleted
                    for (const connId of Object.keys(active)) {
                        if (active[connId] && toDelete.has(active[connId]!)) {
                            active[connId] = null;
                        }
                    }
                    return { nodes: next, expandedIds: expanded, activeFileByConnection: active };
                });
            },

            renameNode: (id, name) => {
                set((s) => ({
                    nodes: {
                        ...s.nodes,
                        [id]: { ...s.nodes[id], name, updatedAt: Date.now() },
                    },
                }));
            },

            updateContent: (id, content) => {
                set((s) => ({
                    nodes: {
                        ...s.nodes,
                        [id]: { ...s.nodes[id], content, updatedAt: Date.now() },
                    },
                }));
            },

            duplicateNode: (id) => {
                const { nodes } = get();
                const node = nodes[id];
                if (!node) return;
                const base = node.name.replace(/(\.\w+)?$/, "");
                const ext = getExtension(node.name) ? `.${getExtension(node.name)}` : "";
                get().createNode(node.connectionId, `${base}_copy${ext}`, node.type, node.parentId, node.content);
            },

            moveNode: (id, newParentId) => {
                set((s) => {
                    const node = s.nodes[id];
                    if (!node || node.parentId === newParentId) return s;
                    // Prevent moving a folder into itself
                    const ancestors = get().getAncestorIds(newParentId ?? "");
                    if (newParentId && (newParentId === id || ancestors.includes(id))) return s;
                    const siblings = get().getChildren(node.connectionId, newParentId);
                    const maxOrder = siblings.reduce((max, n) => Math.max(max, n.order), -1);
                    return {
                        nodes: {
                            ...s.nodes,
                            [id]: { ...node, parentId: newParentId, order: maxOrder + 1, updatedAt: Date.now() },
                        },
                    };
                });
                if (newParentId) {
                    set((s) => ({ expandedIds: { ...s.expandedIds, [newParentId]: true } }));
                }
            },

            toggleFolder: (id) => {
                set((s) => ({ expandedIds: { ...s.expandedIds, [id]: !s.expandedIds[id] } }));
            },

            setExpanded: (id, expanded) => {
                set((s) => ({ expandedIds: { ...s.expandedIds, [id]: expanded } }));
            },

            expandAll: (connectionId) => {
                set((s) => {
                    const expanded = { ...s.expandedIds };
                    for (const node of Object.values(s.nodes)) {
                        if (node.connectionId === connectionId && node.type === "folder") {
                            expanded[node.id] = true;
                        }
                    }
                    return { expandedIds: expanded };
                });
            },

            collapseAll: (connectionId) => {
                set((s) => {
                    const expanded = { ...s.expandedIds };
                    for (const node of Object.values(s.nodes)) {
                        if (node.connectionId === connectionId && node.type === "folder") {
                            expanded[node.id] = false;
                        }
                    }
                    return { expandedIds: expanded };
                });
            },

            setActiveFile: (connectionId, id) => {
                set((s) => ({
                    activeFileByConnection: { ...s.activeFileByConnection, [connectionId]: id },
                }));
                // Auto-expand ancestors when opening a file
                if (id) {
                    const ancestorIds = get().getAncestorIds(id);
                    if (ancestorIds.length > 0) {
                        set((s) => {
                            const expanded = { ...s.expandedIds };
                            ancestorIds.forEach((aid) => { expanded[aid] = true; });
                            return { expandedIds: expanded };
                        });
                    }
                }
            },

            getActiveFile: (connectionId) => {
                return get().activeFileByConnection[connectionId] ?? null;
            },

            ensureConnectionProject: (connectionId, databaseName) => {
                const existing = get().getRootNodes(connectionId);
                if (existing.length > 0) return;

                // Migration: older builds stored Explorer data under a fallback "default" key.
                // If present, re-scope it to the live connection so Git sync can see files.
                const legacyDefaultNodes = Object.values(get().nodes).filter(
                    (node) => node.connectionId === "default"
                );
                if (legacyDefaultNodes.length > 0) {
                    set((s) => {
                        const nextNodes: Record<string, FsNode> = { ...s.nodes };
                        for (const node of Object.values(nextNodes)) {
                            if (node.connectionId === "default") {
                                nextNodes[node.id] = { ...node, connectionId };
                            }
                        }
                        const nextActive = { ...s.activeFileByConnection };
                        if (!nextActive[connectionId] && nextActive.default) {
                            nextActive[connectionId] = nextActive.default;
                        }
                        delete nextActive.default;
                        return { nodes: nextNodes, activeFileByConnection: nextActive };
                    });
                    return;
                }

                // Migration: reconnects can generate a new runtime connection id.
                // If we find a single existing workspace root with the same database name,
                // transfer that tree to the current connection id.
                const normalizedDb = (databaseName ?? "").trim().toLowerCase();
                const candidateConnectionIds = Array.from(
                    new Set(
                        Object.values(get().nodes)
                            .filter(
                                (node) =>
                                    node.type === "folder" &&
                                    node.parentId === null &&
                                    node.connectionId !== connectionId &&
                                    typeof node.name === "string" &&
                                    node.name.trim().toLowerCase() === normalizedDb
                            )
                            .map((node) => node.connectionId)
                    )
                );
                if (candidateConnectionIds.length === 1) {
                    const fromConnectionId = candidateConnectionIds[0];
                    set((s) => {
                        const nextNodes: Record<string, FsNode> = { ...s.nodes };
                        for (const node of Object.values(nextNodes)) {
                            if (node.connectionId === fromConnectionId) {
                                nextNodes[node.id] = { ...node, connectionId };
                            }
                        }
                        const nextActive = { ...s.activeFileByConnection };
                        if (!nextActive[connectionId] && nextActive[fromConnectionId]) {
                            nextActive[connectionId] = nextActive[fromConnectionId];
                        }
                        delete nextActive[fromConnectionId];
                        return { nodes: nextNodes, activeFileByConnection: nextActive };
                    });
                    return;
                }

                // Create starter structure
                const rootFolder = get().createNode(connectionId, databaseName, "folder", null);
                const queriesFolder = get().createNode(connectionId, "queries", "folder", rootFolder.id);
                const templatesFolder = get().createNode(connectionId, "templates", "folder", rootFolder.id);
                get().createNode(connectionId, "README.md", "file", rootFolder.id, `# ${databaseName}\n\nSQL workspace for **${databaseName}**.\n`);
                get().createNode(connectionId, "select_all.sql", "file", queriesFolder.id, `SELECT *\nFROM your_table\nLIMIT 100;`);
                get().createNode(connectionId, "table_sizes.sql", "file", queriesFolder.id,
                    `SELECT schemaname, tablename,\n  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size\nFROM pg_tables\nWHERE schemaname NOT IN ('pg_catalog','information_schema')\nORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;`
                );
                get().createNode(connectionId, "insert_template.sql", "file", templatesFolder.id,
                    `INSERT INTO your_table (col1, col2)\nVALUES ('value1', 'value2')\nRETURNING *;`
                );
                // Auto-expand root
                set((s) => ({ expandedIds: { ...s.expandedIds, [rootFolder.id]: true } }));
            },

            getRelativePathForNode: (nodeId) => {
                const { nodes } = get();
                const node = nodes[nodeId];
                if (!node || node.type !== "file") return null;
                const segments: string[] = [node.name];
                let current = node.parentId ? nodes[node.parentId] : null;
                while (current) {
                    segments.unshift(current.name);
                    current = current.parentId ? nodes[current.parentId] : null;
                }
                return segments.join("/");
            },

            getAllFileEntries: (connectionId) => {
                const { nodes } = get();
                const entries: { path: string; content: string }[] = [];
                for (const n of Object.values(nodes)) {
                    if (n.connectionId !== connectionId || n.type !== "file") continue;
                    const path = get().getRelativePathForNode(n.id);
                    if (path) entries.push({ path, content: n.content });
                }
                return entries;
            },

            getFileCount: (connectionId) => {
                let count = 0;
                for (const node of Object.values(get().nodes)) {
                    if (node.connectionId === connectionId && node.type === "file") {
                        count += 1;
                    }
                }
                return count;
            },

            getConnectionSyncFingerprint: (connectionId) => {
                const signatures: string[] = [];
                for (const node of Object.values(get().nodes)) {
                    if (node.connectionId !== connectionId || node.type !== "file") continue;
                    signatures.push(`${node.id}:${node.updatedAt}:${node.parentId ?? ""}:${node.name}`);
                }
                signatures.sort();

                // 32-bit FNV-1a hash for cheap and stable change detection.
                let hash = 2166136261;
                for (const signature of signatures) {
                    for (let i = 0; i < signature.length; i += 1) {
                        hash ^= signature.charCodeAt(i);
                        hash = Math.imul(hash, 16777619);
                    }
                }
                return `${signatures.length}:${(hash >>> 0).toString(16)}`;
            },

            getConnectionWorkspaceSnapshot: (connectionId) => {
                const { nodes, expandedIds, activeFileByConnection } = get();
                const scopedNodes: Record<string, FsNode> = {};
                for (const [id, node] of Object.entries(nodes)) {
                    if (node.connectionId === connectionId) {
                        scopedNodes[id] = node;
                    }
                }

                const scopedExpandedIds = Object.keys(expandedIds).filter((id) => {
                    if (!expandedIds[id]) return false;
                    return scopedNodes[id]?.type === "folder";
                });

                return {
                    fingerprint: get().getConnectionSyncFingerprint(connectionId),
                    activeFileId: activeFileByConnection[connectionId] ?? null,
                    expandedIds: scopedExpandedIds,
                    nodes: scopedNodes,
                };
            },

            replaceConnectionWorkspace: (connectionId, snapshot) => {
                const incomingNodes = Object.values(snapshot.nodes ?? {}).map((node) => ({
                    ...node,
                    connectionId,
                }));
                const incomingNodeIds = new Set(incomingNodes.map((node) => node.id));
                const safeActiveFileId =
                    snapshot.activeFileId && incomingNodeIds.has(snapshot.activeFileId)
                        ? snapshot.activeFileId
                        : null;

                set((s) => {
                    const nextNodes: Record<string, FsNode> = {};
                    for (const [id, node] of Object.entries(s.nodes)) {
                        if (node.connectionId !== connectionId) {
                            nextNodes[id] = node;
                        }
                    }
                    for (const node of incomingNodes) {
                        nextNodes[node.id] = node;
                    }

                    const nextExpandedIds = { ...s.expandedIds };
                    for (const [id, node] of Object.entries(s.nodes)) {
                        if (node.connectionId === connectionId) {
                            delete nextExpandedIds[id];
                        }
                    }
                    for (const expandedId of snapshot.expandedIds ?? []) {
                        if (
                            incomingNodeIds.has(expandedId) &&
                            nextNodes[expandedId]?.connectionId === connectionId &&
                            nextNodes[expandedId]?.type === "folder"
                        ) {
                            nextExpandedIds[expandedId] = true;
                        }
                    }

                    return {
                        nodes: nextNodes,
                        expandedIds: nextExpandedIds,
                        activeFileByConnection: {
                            ...s.activeFileByConnection,
                            [connectionId]: safeActiveFileId,
                        },
                    };
                });
            },
        }),
        {
            name: "helix-ide-fs",
            partialize: (state) => ({
                nodes: state.nodes,
                expandedIds: state.expandedIds,
                activeFileByConnection: state.activeFileByConnection,
            }),
        }
    )
);

export { getExtension };
