import { create } from "zustand";
import type { QueryNote } from "@/lib/types";
import { notesLoadAll, notesSave, notesDelete } from "@/lib/tauri";

const PAGE_SIZE = 30;

interface NotesState {
    notes: QueryNote[];
    isLoading: boolean;
    error: string | null;
    searchQuery: string;
    displayCount: number; // how many notes to show (infinite scroll)

    // Derived
    filteredNotes: () => QueryNote[];
    visibleNotes: () => QueryNote[];
    hasMore: () => boolean;

    // Actions
    loadNotes: () => Promise<void>;
    saveNote: (note: QueryNote) => Promise<void>;
    updateNote: (note: QueryNote) => Promise<void>;
    deleteNote: (id: string) => Promise<void>;
    setSearch: (query: string) => void;
    loadMore: () => void;
    resetScroll: () => void;
}

export const useNotesStore = create<NotesState>((set, get) => ({
    notes: [],
    isLoading: false,
    error: null,
    searchQuery: "",
    displayCount: PAGE_SIZE,

    filteredNotes: () => {
        const { notes, searchQuery } = get();
        if (!searchQuery.trim()) return notes;
        const q = searchQuery.toLowerCase();
        return notes.filter(
            (n) =>
                n.title.toLowerCase().includes(q) ||
                n.sql.toLowerCase().includes(q)
        );
    },

    visibleNotes: () => {
        const filtered = get().filteredNotes();
        return filtered.slice(0, get().displayCount);
    },

    hasMore: () => {
        return get().displayCount < get().filteredNotes().length;
    },

    loadNotes: async () => {
        set({ isLoading: true, error: null });
        try {
            const notes = await notesLoadAll();
            set({ notes, isLoading: false });
        } catch (err) {
            set({
                error: err instanceof Error ? err.message : String(err),
                isLoading: false,
            });
        }
    },

    saveNote: async (note: QueryNote) => {
        set({ error: null });
        try {
            const notes = await notesSave(note);
            set({ notes });
        } catch (err) {
            set({ error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    },

    updateNote: async (note: QueryNote) => {
        set({ error: null });
        try {
            const notes = await notesSave(note);
            set({ notes });
        } catch (err) {
            set({ error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    },

    deleteNote: async (id: string) => {
        set({ error: null });
        try {
            const notes = await notesDelete(id);
            set({ notes });
        } catch (err) {
            set({ error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    },

    setSearch: (query: string) => {
        set({ searchQuery: query, displayCount: PAGE_SIZE });
    },

    loadMore: () => {
        set((s) => ({ displayCount: s.displayCount + PAGE_SIZE }));
    },

    resetScroll: () => {
        set({ displayCount: PAGE_SIZE });
    },
}));
