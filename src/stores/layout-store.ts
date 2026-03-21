import { create } from "zustand";

/** One tab in the Data view (table, view, function, type, or event trigger). */
export type LayoutTab =
    | { kind: "table"; id: string; schema: string; table: string }
    | { kind: "view"; id: string; schema: string; table: string }
    | {
          kind: "function";
          id: string;
          schema: string;
          name: string;
          arguments: string;
          isTrigger: boolean;
      }
    | { kind: "type"; id: string; schema: string; name: string }
    | { kind: "event_trigger"; id: string; name: string };

/** @deprecated Use LayoutTab */
export type TableTab = LayoutTab;

export function layoutTabIdForFunction(schema: string, name: string, args: string): string {
    return `fn:${encodeURIComponent(schema)}:${encodeURIComponent(name)}:${encodeURIComponent(args)}`;
}

export function layoutTabIdForType(schema: string, name: string): string {
    return `ty:${encodeURIComponent(schema)}:${encodeURIComponent(name)}`;
}

export function layoutTabIdForEventTrigger(name: string): string {
    return `et:${encodeURIComponent(name)}`;
}

/** Short label for the Data view tab bar (truncates long argument lists). */
export function layoutTabTitle(tab: LayoutTab, maxArgChars = 32): string {
    switch (tab.kind) {
        case "table":
        case "view":
            return tab.table;
        case "function": {
            const a = tab.arguments.trim();
            if (!a) return `${tab.name}()`;
            const short = a.length > maxArgChars ? `${a.slice(0, maxArgChars)}…` : a;
            return `${tab.name}(${short})`;
        }
        case "type":
            return tab.name;
        case "event_trigger":
            return tab.name;
    }
}

export type SplitDirection = "horizontal" | "vertical";

export interface PaneNode {
    type: "pane";
    id: string;
    tabs: LayoutTab[];
    activeTabId: string | null;
}

export interface SplitNode {
    type: "split";
    id: string;
    direction: SplitDirection;
    children: LayoutNode[]; // usually 2
    sizes: number[]; // percentages, e.g. [50, 50]
}

export type LayoutNode = PaneNode | SplitNode;

interface LayoutState {
    root: LayoutNode;
    activePaneId: string | null;
    
    // Actions
    openTab: (schema: string, table: string, options?: { isView?: boolean }) => void;
    openFunctionTab: (schema: string, name: string, args: string, isTrigger: boolean) => void;
    openTypeTab: (schema: string, name: string) => void;
    openEventTriggerTab: (name: string) => void;
    closeTab: (paneId: string, tabId: string) => void;
    closeOtherTabs: (paneId: string, tabId: string) => void;
    closeTabsToRight: (paneId: string, tabId: string) => void;
    closeAllTabs: (paneId: string) => void;
    setActiveTab: (paneId: string, tabId: string) => void;
    setActivePane: (paneId: string) => void;
    splitPane: (paneId: string, direction: SplitDirection, newTab?: LayoutTab) => void;
    moveTab: (sourcePaneId: string, targetPaneId: string, tabId: string) => void;
    setSizes: (splitNodeId: string, sizes: number[]) => void;
    resetLayout: () => void;
}

let paneCounter = 1;
let splitCounter = 1;

function generatePaneId() { return `pane_${paneCounter++}`; }
function generateSplitId() { return `split_${splitCounter++}`; }

function findPane(node: LayoutNode, paneId: string): PaneNode | null {
    if (node.type === "pane") {
        return node.id === paneId ? node : null;
    }
    for (const child of node.children) {
        const found = findPane(child, paneId);
        if (found) return found;
    }
    return null;
}

function findNodeParent(node: LayoutNode, targetId: string): SplitNode | null {
    if (node.type === "pane") return null;
    if (node.children.some(c => c.id === targetId)) {
        return node;
    }
    for (const child of node.children) {
        const found = findNodeParent(child, targetId);
        if (found) return found;
    }
    return null;
}

// Map tree and replace a specific node
function mapTree(node: LayoutNode, targetId: string, mapFn: (n: LayoutNode) => LayoutNode): LayoutNode {
    if (node.id === targetId) {
        return mapFn(node);
    }
    if (node.type === "split") {
        return {
            ...node,
            children: node.children.map(c => mapTree(c, targetId, mapFn))
        };
    }
    return node;
}

// Return true if node is a pane with no tabs, or a split with 0 children
function isEmpty(node: LayoutNode): boolean {
    if (node.type === "pane") {
        return node.tabs.length === 0;
    }
    return node.children.length === 0;
}

// Cleans up empty panes and simplifies splits with 1 child
function cleanupTree(node: LayoutNode): LayoutNode | null {
    if (node.type === "pane") {
        return node.tabs.length === 0 ? null : node;
    }
    
    const cleanedChildren = node.children
        .map(cleanupTree)
        .filter((c): c is LayoutNode => c !== null);
        
    if (cleanedChildren.length === 0) {
        return null;
    }
    
    if (cleanedChildren.length === 1) {
        return cleanedChildren[0];
    }
    
    // Normalize sizes if child count changed
    let sizes = node.sizes;
    if (sizes.length !== cleanedChildren.length) {
        const equalSize = 100 / cleanedChildren.length;
        sizes = cleanedChildren.map(() => equalSize);
    }
    
    return {
        ...node,
        children: cleanedChildren,
        sizes
    };
}

export const useLayoutStore = create<LayoutState>((set) => {
    
    const defaultRoot: PaneNode = {
        type: "pane",
        id: generatePaneId(),
        tabs: [],
        activeTabId: null
    };

    const upsertLayoutTab = (newTab: LayoutTab) => {
        const tabId = newTab.id;
        set((state) => {
            let paneId = state.activePaneId;
            let pane = paneId ? findPane(state.root, paneId) : null;

            if (!pane) {
                const firstPane = (function findFirst(n: LayoutNode): PaneNode | null {
                    if (n.type === "pane") return n;
                    for (const c of n.children) {
                        const found = findFirst(c);
                        if (found) return found;
                    }
                    return null;
                })(state.root);

                if (firstPane) {
                    pane = firstPane;
                    paneId = pane.id;
                } else {
                    const newRoot: PaneNode = {
                        ...defaultRoot,
                        id: generatePaneId(),
                        tabs: [newTab],
                        activeTabId: tabId,
                    };
                    return { root: newRoot, activePaneId: newRoot.id };
                }
            }

            if (pane.tabs.some((t) => t.id === tabId)) {
                return {
                    root: mapTree(state.root, paneId!, (p) => ({
                        ...p,
                        activeTabId: tabId,
                    })) as LayoutNode,
                    activePaneId: paneId,
                };
            }

            return {
                root: mapTree(state.root, paneId!, (p) => {
                    const pp = p as PaneNode;
                    return {
                        ...pp,
                        tabs: [...pp.tabs, newTab],
                        activeTabId: tabId,
                    };
                }) as LayoutNode,
                activePaneId: paneId,
            };
        });
    };

    return {
        root: defaultRoot,
        activePaneId: defaultRoot.id,

        openTab: (schema: string, table: string, options?: { isView?: boolean }) => {
            const tabId = `${schema}:${table}`;
            const kind = options?.isView ? ("view" as const) : ("table" as const);
            upsertLayoutTab({ kind, id: tabId, schema, table });
        },

        openFunctionTab: (schema: string, name: string, args: string, isTrigger: boolean) => {
            upsertLayoutTab({
                kind: "function",
                id: layoutTabIdForFunction(schema, name, args),
                schema,
                name,
                arguments: args,
                isTrigger,
            });
        },

        openTypeTab: (schema: string, name: string) => {
            upsertLayoutTab({
                kind: "type",
                id: layoutTabIdForType(schema, name),
                schema,
                name,
            });
        },

        openEventTriggerTab: (name: string) => {
            upsertLayoutTab({
                kind: "event_trigger",
                id: layoutTabIdForEventTrigger(name),
                name,
            });
        },

        closeTab: (paneId: string, tabId: string) => {
            set(state => {
                const pane = findPane(state.root, paneId);
                if (!pane) return state;

                const newTabs = pane.tabs.filter(t => t.id !== tabId);
                let newActive = pane.activeTabId;
                
                // Fallback activation
                if (newActive === tabId) {
                    const idx = pane.tabs.findIndex(t => t.id === tabId);
                    if (newTabs.length > 0) {
                        newActive = newTabs[Math.max(0, idx - 1)].id;
                    } else {
                        newActive = null;
                    }
                }
                
                const updatedRoot = mapTree(state.root, paneId, p => ({
                    ...(p as PaneNode),
                    tabs: newTabs,
                    activeTabId: newActive
                })) as LayoutNode;

                const cleanedRoot = cleanupTree(updatedRoot);
                
                // If everything closed, reset to a single empty pane
                if (!cleanedRoot) {
                    const newRoot: PaneNode = { type: "pane", id: generatePaneId(), tabs: [], activeTabId: null };
                    return { root: newRoot, activePaneId: newRoot.id };
                }

                return { 
                    root: cleanedRoot,
                    // If the active pane was deleted, the activePaneId will point to nothing, but it's okay for now.
                    // We can attempt to pick the first pane if activePaneId doesn't exist.
                };
            });
        },

        closeOtherTabs: (paneId: string, tabId: string) => {
            set(state => {
                const pane = findPane(state.root, paneId);
                if (!pane) return state;

                const tabToKeep = pane.tabs.find(t => t.id === tabId);
                if (!tabToKeep) return state;

                return {
                    root: mapTree(state.root, paneId, p => ({
                        ...(p as PaneNode),
                        tabs: [tabToKeep],
                        activeTabId: tabId
                    })) as LayoutNode,
                    activePaneId: paneId
                };
            });
        },

        closeTabsToRight: (paneId: string, tabId: string) => {
            set(state => {
                const pane = findPane(state.root, paneId);
                if (!pane) return state;

                const idx = pane.tabs.findIndex(t => t.id === tabId);
                if (idx === -1) return state;

                const newTabs = pane.tabs.slice(0, idx + 1);
                
                // If the active tab was among those closed, activate the tabId
                let newActiveTabId = pane.activeTabId;
                if (!newTabs.some(t => t.id === newActiveTabId)) {
                    newActiveTabId = tabId;
                }

                return {
                    root: mapTree(state.root, paneId, p => ({
                        ...(p as PaneNode),
                        tabs: newTabs,
                        activeTabId: newActiveTabId
                    })) as LayoutNode,
                    activePaneId: paneId
                };
            });
        },

        closeAllTabs: (paneId: string) => {
            set(state => {
                const updatedRoot = mapTree(state.root, paneId, p => ({
                    ...(p as PaneNode),
                    tabs: [],
                    activeTabId: null
                })) as LayoutNode;

                const cleanedRoot = cleanupTree(updatedRoot);
                
                if (!cleanedRoot) {
                    const newRoot: PaneNode = { type: "pane", id: generatePaneId(), tabs: [], activeTabId: null };
                    return { root: newRoot, activePaneId: newRoot.id };
                }

                return { root: cleanedRoot };
            });
        },

        setActiveTab: (paneId: string, tabId: string) => {
            set(state => {
                return {
                    root: mapTree(state.root, paneId, p => ({
                        ...p,
                        activeTabId: tabId
                    })) as LayoutNode,
                    activePaneId: paneId
                };
            });
        },

        setActivePane: (paneId: string) => {
            set({ activePaneId: paneId });
        },

        splitPane: (paneId: string, direction: SplitDirection, newTab?: LayoutTab) => {
            set(state => {
                const sourcePane = findPane(state.root, paneId);
                if (!sourcePane) return state;

                const newPane: PaneNode = {
                    type: "pane",
                    id: generatePaneId(),
                    tabs: newTab ? [newTab] : [],
                    activeTabId: newTab ? newTab.id : null
                };

                const splitNode: SplitNode = {
                    type: "split",
                    id: generateSplitId(),
                    direction,
                    children: [sourcePane, newPane],
                    sizes: [50, 50]
                };

                return {
                    root: mapTree(state.root, paneId, () => splitNode) as LayoutNode,
                    activePaneId: newPane.id
                };
            });
        },
        
        moveTab: (sourcePaneId: string, targetPaneId: string, tabId: string) => {
            set(state => {
                const sourcePane = findPane(state.root, sourcePaneId);
                const targetPane = findPane(state.root, targetPaneId);
                if (!sourcePane || !targetPane) return state;

                const tab = sourcePane.tabs.find(t => t.id === tabId);
                if (!tab) return state;

                // 1. Remove from source
                const newSourceTabs = sourcePane.tabs.filter(t => t.id !== tabId);
                let newSourceActive = sourcePane.activeTabId;
                if (newSourceActive === tabId) {
                    const idx = sourcePane.tabs.findIndex(t => t.id === tabId);
                    newSourceActive = newSourceTabs.length > 0 
                        ? newSourceTabs[Math.max(0, idx - 1)].id 
                        : null;
                }

                // 2. Add to target
                // If it already exists in target, just select it. Otherwise, add it.
                let newTargetTabs = targetPane.tabs;
                if (!targetPane.tabs.some(t => t.id === tabId)) {
                    newTargetTabs = [...targetPane.tabs, tab];
                }

                let updatedRoot = mapTree(state.root, sourcePaneId, p => ({
                    ...p, tabs: newSourceTabs, activeTabId: newSourceActive
                })) as LayoutNode;

                updatedRoot = mapTree(updatedRoot, targetPaneId, p => ({
                    ...p, tabs: newTargetTabs, activeTabId: tabId
                })) as LayoutNode;

                const cleanedRoot = cleanupTree(updatedRoot);
                if (!cleanedRoot) {
                    const newRoot: PaneNode = { type: "pane", id: generatePaneId(), tabs: [], activeTabId: null };
                    return { root: newRoot, activePaneId: newRoot.id };
                }

                return { root: cleanedRoot, activePaneId: targetPaneId };
            });
        },

        setSizes: (splitNodeId: string, sizes: number[]) => {
            set(state => {
                return {
                    root: mapTree(state.root, splitNodeId, p => ({
                        ...p,
                        sizes
                    })) as LayoutNode
                };
            });
        },
        
        resetLayout: () => {
            const newRoot: PaneNode = {
                type: "pane",
                id: generatePaneId(),
                tabs: [],
                activeTabId: null
            };
            set({ root: newRoot, activePaneId: newRoot.id });
        }
    };
});
