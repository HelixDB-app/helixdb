const COLLABORATOR_COLORS = [
    "#3b82f6",
    "#ec4899",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#ef4444",
    "#06b6d4",
    "#84cc16",
    "#f97316",
    "#22c55e",
    "#14b8a6",
    "#e11d48",
] as const;

export function getCollaboratorColor(index: number): string {
    if (!Number.isFinite(index) || index < 0) return COLLABORATOR_COLORS[0];
    return COLLABORATOR_COLORS[index % COLLABORATOR_COLORS.length];
}

export function getColorIndexFromUserId(userId: string): number {
    let hash = 5381;
    for (let i = 0; i < userId.length; i += 1) {
        hash = ((hash << 5) + hash) ^ userId.charCodeAt(i);
    }
    return Math.abs(hash) % COLLABORATOR_COLORS.length;
}

export function getInitials(name: string | null | undefined): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "U";
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export const MAX_COLOR_INDEX = COLLABORATOR_COLORS.length - 1;
