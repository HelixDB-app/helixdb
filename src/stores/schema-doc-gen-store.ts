import { create } from "zustand";

interface SchemaDocGenState {
    /** Called when a schema README.doc file is updated (e.g. after background AI generation). */
    onSchemaDocFileUpdated: ((fileId: string, content: string) => void) | null;
    setOnSchemaDocFileUpdated: (fn: ((fileId: string, content: string) => void) | null) => void;
}

export const useSchemaDocGenStore = create<SchemaDocGenState>((set) => ({
    onSchemaDocFileUpdated: null,
    setOnSchemaDocFileUpdated: (fn) => set({ onSchemaDocFileUpdated: fn }),
}));

export function notifySchemaDocFileUpdated(fileId: string, content: string): void {
    useSchemaDocGenStore.getState().onSchemaDocFileUpdated?.(fileId, content);
}
