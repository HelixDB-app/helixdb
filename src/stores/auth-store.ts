import { create } from "zustand";

import { setWebDataPlaneBearerToken } from "@/lib/web-data-plane-token";
import { setWebAccountJwt } from "@/lib/web-account-jwt";

export interface UserProfile {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    provider: string;
    createdAt: string;
}

interface AuthState {
    user: UserProfile | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    /** Set after login to validate deep-link state param */
    pendingState: string | null;

    setUser: (user: UserProfile | null) => void;
    setLoading: (v: boolean) => void;
    setPendingState: (state: string | null) => void;
    logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    pendingState: null,

    setUser: (user) => set({ user, isAuthenticated: !!user }),
    setLoading: (isLoading) => set({ isLoading }),
    setPendingState: (pendingState) => set({ pendingState }),
    logout: () => {
        setWebDataPlaneBearerToken(null);
        setWebAccountJwt(null);
        set({ user: null, isAuthenticated: false, pendingState: null });
    },
}));
