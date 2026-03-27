"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useTheme } from "next-themes";
import {
    useSettingsStore,
    type AppTheme,
    type UIDensity,
    type EditorTabSize,
    type DefaultPageSize,
    type NullDisplay,
    type GeminiModelId,
    type GitAiProvider,
} from "@/stores/settings-store";
import {
    useShortcutsStore,
    SHORTCUT_DEFINITIONS,
    type ShortcutActionId,
} from "@/stores/shortcuts-store";
import { FORMAT_SQL_KEY_COMBO } from "@/lib/format-sql";
import { formatShortcutKeys, eventToCombo } from "@/lib/shortcut-keys";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { APP_NAME, APP_VERSION } from "@/lib/app-config";
import { useUpdateStore } from "@/stores/update-store";
import { isTauriRuntime } from "@/lib/runtime";
import {
    biometricGetStatus,
    type BiometricStatusPayload,
    securityGetBiometricLock,
    securityGetBiometricSensitiveOps,
    securitySetBiometricLock,
    securitySetBiometricSensitiveOps,
} from "@/lib/security-biometric";
import {
    Sun,
    Moon,
    Monitor,
    Palette,
    Code2,
    Table2,
    Terminal,
    Keyboard,
    Info,
    Fingerprint,
    RotateCcw,
    Check,
    Minus,
    Plus,
    Zap,
    Sparkles,
    Eye,
    EyeOff,
    ExternalLink,
    Pencil,
    RotateCcw as ResetIcon,
    MessageSquareText,
    MessageSquare,
    ArrowUpRight,
    Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ── Section Types ────────────────────────────────────────────────────────────

export type SettingsSection =
    | "appearance"
    | "editor"
    | "data"
    | "query"
    | "ai"
    | "shortcuts"
    | "security"
    | "about";

const ALL_SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: "appearance", label: "Appearance", icon: <Palette className="h-3.5 w-3.5" /> },
    { id: "editor", label: "Editor", icon: <Code2 className="h-3.5 w-3.5" /> },
    { id: "data", label: "Data", icon: <Table2 className="h-3.5 w-3.5" /> },
    { id: "query", label: "Query", icon: <Terminal className="h-3.5 w-3.5" /> },
    { id: "ai", label: "AI", icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: "shortcuts", label: "Shortcuts", icon: <Keyboard className="h-3.5 w-3.5" /> },
    { id: "security", label: "Security", icon: <Fingerprint className="h-3.5 w-3.5" /> },
    { id: "about", label: "About", icon: <Info className="h-3.5 w-3.5" /> },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function SettingRow({
    label,
    description,
    children,
}: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-6 py-3">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground/90">{label}</p>
                {description && (
                    <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
                        {description}
                    </p>
                )}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="space-y-0">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1 px-1">
                {title}
            </h3>
            <div className="rounded-lg border border-border/30 bg-card/30 divide-y divide-border/20 px-4">
                {children}
            </div>
        </div>
    );
}

function StepInput({
    value,
    min,
    max,
    step = 1,
    onChange,
    format,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    format?: (v: number) => string;
}) {
    return (
        <div className="flex items-center gap-1.5">
            <button
                type="button"
                onClick={() => onChange(Math.max(min, value - step))}
                disabled={value <= min}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
                <Minus className="h-3 w-3" />
            </button>
            <span className="w-10 text-center text-sm font-mono text-foreground/90">
                {format ? format(value) : value}
            </span>
            <button
                type="button"
                onClick={() => onChange(Math.min(max, value + step))}
                disabled={value >= max}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
                <Plus className="h-3 w-3" />
            </button>
        </div>
    );
}

function SegmentedControl<T extends string | number>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string; icon?: React.ReactNode }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex items-center rounded-lg bg-muted/40 p-0.5 gap-0.5">
            {options.map((opt) => (
                <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => onChange(opt.value)}
                    className={cn(
                        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                        value === opt.value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {opt.icon}
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function AppearanceSection() {
    const { theme: nextTheme, setTheme } = useTheme();
    const { uiDensity, reducedMotion, updateSettings } = useSettingsStore();

    const currentTheme = (nextTheme as AppTheme) ?? "dark";

    const themeOptions: { value: AppTheme; label: string; icon: React.ReactNode }[] = [
        { value: "light", label: "Light", icon: <Sun className="h-3 w-3" /> },
        { value: "dark", label: "Dark", icon: <Moon className="h-3 w-3" /> },
        { value: "system", label: "System", icon: <Monitor className="h-3 w-3" /> },
    ];

    const densityOptions: { value: UIDensity; label: string }[] = [
        { value: "compact", label: "Compact" },
        { value: "comfortable", label: "Comfortable" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="Theme">
                <SettingRow
                    label="Color scheme"
                    description="Choose between light, dark, or follow your system setting."
                >
                    <SegmentedControl
                        value={currentTheme}
                        options={themeOptions}
                        onChange={(v) => setTheme(v)}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Layout">
                <SettingRow
                    label="UI density"
                    description="Adjusts padding and spacing throughout the interface."
                >
                    <SegmentedControl
                        value={uiDensity}
                        options={densityOptions}
                        onChange={(v) => updateSettings({ uiDensity: v as UIDensity })}
                    />
                </SettingRow>
                <SettingRow
                    label="Reduce motion"
                    description="Minimize animations and transitions."
                >
                    <Switch
                        checked={reducedMotion}
                        onCheckedChange={(v) => updateSettings({ reducedMotion: v })}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

function EditorSection() {
    const {
        editorFontSize,
        editorTabSize,
        editorWordWrap,
        editorMinimap,
        editorLineNumbers,
        editorFontLigatures,
        updateSettings,
    } = useSettingsStore();

    const tabSizeOptions: { value: EditorTabSize; label: string }[] = [
        { value: 2, label: "2 spaces" },
        { value: 4, label: "4 spaces" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="Typography">
                <SettingRow
                    label="Font size"
                    description="Size of the monospace font in the SQL editor."
                >
                    <StepInput
                        value={editorFontSize}
                        min={10}
                        max={20}
                        onChange={(v) => updateSettings({ editorFontSize: v })}
                        format={(v) => `${v}px`}
                    />
                </SettingRow>
                <SettingRow
                    label="Font ligatures"
                    description="Render ligature glyphs in supported monospace fonts."
                >
                    <Switch
                        checked={editorFontLigatures}
                        onCheckedChange={(v) => updateSettings({ editorFontLigatures: v })}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Formatting">
                <SettingRow
                    label="Tab size"
                    description="Number of spaces per indentation level."
                >
                    <SegmentedControl
                        value={editorTabSize}
                        options={tabSizeOptions}
                        onChange={(v) => updateSettings({ editorTabSize: v as EditorTabSize })}
                    />
                </SettingRow>
                <SettingRow
                    label="Word wrap"
                    description="Wrap long lines instead of showing a horizontal scrollbar."
                >
                    <Switch
                        checked={editorWordWrap}
                        onCheckedChange={(v) => updateSettings({ editorWordWrap: v })}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Display">
                <SettingRow
                    label="Line numbers"
                    description="Show line numbers in the gutter."
                >
                    <Switch
                        checked={editorLineNumbers}
                        onCheckedChange={(v) => updateSettings({ editorLineNumbers: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Minimap"
                    description="Show the code minimap scrollbar on the right side."
                >
                    <Switch
                        checked={editorMinimap}
                        onCheckedChange={(v) => updateSettings({ editorMinimap: v })}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

function DataSection() {
    const {
        defaultPageSize,
        nullDisplay,
        showRowNumbers,
        wrapCellContent,
        updateSettings,
    } = useSettingsStore();

    const pageSizeOptions: { value: DefaultPageSize; label: string }[] = [
        { value: 50, label: "50" },
        { value: 100, label: "100" },
        { value: 200, label: "200" },
        { value: 500, label: "500" },
    ];

    const nullOptions: { value: NullDisplay; label: string }[] = [
        { value: "NULL", label: "NULL" },
        { value: "–", label: "–" },
        { value: "", label: "blank" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="Pagination">
                <SettingRow
                    label="Rows per page"
                    description="Default number of rows fetched per page in the data browser."
                >
                    <SegmentedControl
                        value={defaultPageSize}
                        options={pageSizeOptions}
                        onChange={(v) => updateSettings({ defaultPageSize: v as DefaultPageSize })}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Display">
                <SettingRow
                    label="Row numbers"
                    description="Show a row number column on the left of the data table."
                >
                    <Switch
                        checked={showRowNumbers}
                        onCheckedChange={(v) => updateSettings({ showRowNumbers: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Wrap cell content"
                    description="Allow cell text to wrap instead of being truncated."
                >
                    <Switch
                        checked={wrapCellContent}
                        onCheckedChange={(v) => updateSettings({ wrapCellContent: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="NULL display"
                    description="How to render NULL values in the data table."
                >
                    <SegmentedControl
                        value={nullDisplay}
                        options={nullOptions}
                        onChange={(v) => updateSettings({ nullDisplay: v as NullDisplay })}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

function QuerySection() {
    const {
        autoFormatOnExecute,
        confirmDangerousQueries,
        strictProductionGuard,
        queryTimeoutSeconds,
        aiReviewEnabled,
        aiReviewAutoOnDml,
        aiReviewUseGemini,
        aiReviewModel,
        aiReviewComplexLineThreshold,
        updateSettings,
    } = useSettingsStore();

    const reviewModelOptions: { value: GeminiModelId; label: string }[] = [
        { value: "gemini-2.5-flash-lite", label: "Flash Lite" },
        { value: "gemini-2.5-flash", label: "Flash" },
        { value: "gemini-2.5-pro", label: "Pro" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="Execution">
                <SettingRow
                    label="Auto-format on execute"
                    description="Automatically format SQL before running it."
                >
                    <Switch
                        checked={autoFormatOnExecute}
                        onCheckedChange={(v) => updateSettings({ autoFormatOnExecute: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Confirm dangerous queries"
                    description="Show a confirmation dialog before running DROP, TRUNCATE, or DELETE without WHERE."
                >
                    <Switch
                        checked={confirmDangerousQueries}
                        onCheckedChange={(v) => updateSettings({ confirmDangerousQueries: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Strict production guard"
                    description="On prod connections, require typed confirmation and a reason before risky SQL (UPDATE/DELETE/ALTER/DROP/TRUNCATE)."
                >
                    <Switch
                        checked={strictProductionGuard}
                        onCheckedChange={(v) => updateSettings({ strictProductionGuard: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Query timeout"
                    description="Automatically cancel queries that exceed this duration."
                >
                    <StepInput
                        value={queryTimeoutSeconds}
                        min={5}
                        max={300}
                        step={5}
                        onChange={(v) => updateSettings({ queryTimeoutSeconds: v })}
                        format={(v) => `${v}s`}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="AI Review Mode">
                <SettingRow
                    label="Enable AI Review Mode"
                    description="Run SQL safety checks before execution and show a review panel."
                >
                    <Switch
                        checked={aiReviewEnabled}
                        onCheckedChange={(v) => updateSettings({ aiReviewEnabled: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Auto-review on DML"
                    description="Automatically review INSERT, UPDATE, DELETE, DROP, and TRUNCATE before execution."
                >
                    <Switch
                        checked={aiReviewAutoOnDml}
                        onCheckedChange={(v) => updateSettings({ aiReviewAutoOnDml: v })}
                        disabled={!aiReviewEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label="Semantic check with Gemini"
                    description="Use Gemini only when local checks flag risk or query is complex."
                >
                    <Switch
                        checked={aiReviewUseGemini}
                        onCheckedChange={(v) => updateSettings({ aiReviewUseGemini: v })}
                        disabled={!aiReviewEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label="Review model"
                    description="Gemini model used for semantic risk analysis."
                >
                    <SegmentedControl
                        value={aiReviewModel}
                        options={reviewModelOptions}
                        onChange={(v) => updateSettings({ aiReviewModel: v as GeminiModelId })}
                    />
                </SettingRow>
                <SettingRow
                    label="Complex query threshold"
                    description="Trigger semantic AI review when SQL exceeds this line count."
                >
                    <StepInput
                        value={aiReviewComplexLineThreshold}
                        min={6}
                        max={40}
                        step={1}
                        onChange={(v) => updateSettings({ aiReviewComplexLineThreshold: v })}
                        format={(v) => `${v} lines`}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

const EDITOR_SHORTCUTS_REF = [
    { keys: ["⌘", "R"], description: "Run AI Review Mode (query editor)" },
    { keys: ["⌘", "Enter"], description: "Execute query in editor" },
    { keys: formatShortcutKeys(FORMAT_SQL_KEY_COMBO), description: "Format SQL in editor" },
    { keys: ["⌘", "."], description: "Trigger AI inline suggestion" },
    { keys: ["⌥", "→"], description: "Accept next AI suggestion word" },
    { keys: ["⌘", "⇧", "P"], description: "Open editor command palette" },
];

function ShortcutsSection() {
    const { getCombo, setShortcut, resetShortcut, resetAllShortcuts, getActionByCombo } = useShortcutsStore();
    const [editingId, setEditingId] = useState<ShortcutActionId | null>(null);
    const appShortcutDefs = SHORTCUT_DEFINITIONS.filter((def) => !def.id.startsWith("git_"));
    const gitShortcutDefs = SHORTCUT_DEFINITIONS.filter((def) => def.id.startsWith("git_"));

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (!editingId) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                setEditingId(null);
                return;
            }
            const combo = eventToCombo(e);
            if (!combo) return;
            const existing = getActionByCombo(combo);
            if (existing && existing !== editingId) {
                toast.warning(`Shortcut already used by "${SHORTCUT_DEFINITIONS.find((d) => d.id === existing)?.label}". Reassigning.`);
            }
            setShortcut(editingId, combo);
            setEditingId(null);
            toast.success("Shortcut updated");
        },
        [editingId, setShortcut, getActionByCombo]
    );

    useEffect(() => {
        if (!editingId) return;
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [editingId, handleKeyDown]);

    const renderShortcutRows = (definitions: typeof SHORTCUT_DEFINITIONS) =>
        definitions.map((def) => {
            const combo = getCombo(def.id);
            const keys = formatShortcutKeys(combo);
            const isEditing = editingId === def.id;
            return (
                <div
                    key={def.id}
                    className={cn(
                        "flex items-center justify-between gap-4 py-2.5",
                        isEditing && "bg-primary/5 rounded-md -mx-2 px-2 border border-primary/20"
                    )}
                >
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground/90">{def.label}</p>
                        <p className="text-[11px] text-muted-foreground/60 truncate">{def.description}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-1 min-w-[80px] justify-end">
                            {isEditing ? (
                                <span className="text-[11px] text-muted-foreground italic">Press a key…</span>
                            ) : (
                                keys.map((key, ki) => (
                                    <kbd
                                        key={ki}
                                        className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border/50 bg-muted/50 px-1.5 font-mono text-[11px] text-foreground/70"
                                    >
                                        {key}
                                    </kbd>
                                ))
                            )}
                        </div>
                        <div className="flex items-center gap-0.5">
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => setEditingId(isEditing ? null : def.id)}
                                title="Edit shortcut"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                    resetShortcut(def.id);
                                    toast.success("Reset to default");
                                }}
                                title="Reset to default"
                            >
                                <ResetIcon className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    </div>
                </div>
            );
        });

    return (
        <div className="space-y-5">
            <SettingSection title="App & header shortcuts">
                <p className="text-xs text-muted-foreground/70 px-1 mb-2">
                    Click Edit, then press the new key combination. Press Escape to cancel.
                </p>
                {renderShortcutRows(appShortcutDefs)}
            </SettingSection>

            <SettingSection title="Git shortcuts (contextual)">
                <p className="text-xs text-muted-foreground/70 px-1 mb-2">
                    Active while the Git tab is focused. Designed for fast stage → commit → push workflows.
                </p>
                {renderShortcutRows(gitShortcutDefs)}
                <div className="flex justify-end pt-2 pb-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                            resetAllShortcuts();
                            toast.success("All shortcuts reset to defaults");
                        }}
                    >
                        Reset all to defaults
                    </Button>
                </div>
            </SettingSection>
            <SettingSection title="Editor & query shortcuts (fixed)">
                <p className="text-xs text-muted-foreground/70 px-1 mb-2">
                    These are defined in the query editor and cannot be changed here.
                </p>
                {EDITOR_SHORTCUTS_REF.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-4 py-2.5">
                        <span className="text-sm text-foreground/80">{s.description}</span>
                        <div className="flex items-center gap-1">
                            {s.keys.map((key, ki) => (
                                <kbd
                                    key={ki}
                                    className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border/50 bg-muted/50 px-1.5 font-mono text-[11px] text-foreground/70"
                                >
                                    {key}
                                </kbd>
                            ))}
                        </div>
                    </div>
                ))}
            </SettingSection>
        </div>
    );
}

function NotificationsToggle() {
    const { notificationsEnabled, updateSettings } = useSettingsStore();
    return (
        <Switch
            checked={notificationsEnabled}
            onCheckedChange={(v) => updateSettings({ notificationsEnabled: v })}
        />
    );
}

function AISection() {
    const {
        geminiApiKey,
        defaultAiModel,
        gitAiProvider,
        cloudflareApiToken,
        cloudflareAccountId,
        cloudflareModel,
        aiAutocompleteEnabled,
        aiInlineSuggestions,
        aiDropdownSuggestions,
        aiNextActionSuggestions,
        aiSuggestionMinChars,
        aiSuggestionThrottleMs,
        aiSuggestionContextWindowChars,
        aiShowSuggestionLatency,
        aiCompletionUrl,
        aiWorkerUrl,
        updateSettings,
    } = useSettingsStore();
    const [showKey, setShowKey] = useState(false);
    const [showCloudflareKey, setShowCloudflareKey] = useState(false);

    const modelOptions: { value: GeminiModelId; label: string }[] = [
        { value: "gemini-2.5-flash", label: "Gemini Flash" },
        { value: "gemini-2.5-pro", label: "Gemini Pro" },
        { value: "gemma3-4b", label: "Gemma 3 4B" },
        { value: "gemma3-12b", label: "Gemma 3 12B" },
        { value: "gemma3-27b", label: "Gemma 3 27B" },
        { value: "gemini-2.5-flash-lite", label: "Gemini Flash Lite" },
        { value: "gemini-2.5-pro-lite", label: "Gemini Pro Lite" },
    ];
    const gitProviderOptions: { value: GitAiProvider; label: string }[] = [
        { value: "cloudflare", label: "Cloudflare (Recommended)" },
        { value: "gemini", label: "Gemini" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="API Configuration">
                <SettingRow
                    label="Gemini API Key"
                    description="Your personal API key for Google Gemini."
                >
                    <div className="flex items-center gap-1.5">
                        <input
                            type={showKey ? "text" : "password"}
                            value={geminiApiKey}
                            onChange={(e) => updateSettings({ geminiApiKey: e.target.value })}
                            placeholder="Enter API key"
                            className="h-7 w-48 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Gemini API key"
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/20 text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={showKey ? "Hide API key" : "Show API key"}
                        >
                            {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </button>
                    </div>
                </SettingRow>
                <div className="py-2.5">
                    <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-emerald-400/80 hover:text-emerald-400 transition-colors"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Get your free API key from Google AI Studio
                    </a>
                </div>
            </SettingSection>

            <SettingSection title="Git AI (Commit / PR)">
                <SettingRow
                    label="Git AI provider"
                    description="Provider used for AI commit messages, rewrites, and PR drafts."
                >
                    <SegmentedControl
                        value={gitAiProvider}
                        options={gitProviderOptions}
                        onChange={(v) => updateSettings({ gitAiProvider: v as GitAiProvider })}
                    />
                </SettingRow>
                <SettingRow
                    label="Cloudflare Account ID"
                    description="Used when Git AI provider is Cloudflare."
                >
                    <input
                        type="text"
                        value={cloudflareAccountId}
                        onChange={(e) => updateSettings({ cloudflareAccountId: e.target.value })}
                        placeholder="Cloudflare account id"
                        className="h-7 w-48 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Cloudflare account id"
                    />
                </SettingRow>
                <SettingRow
                    label="Cloudflare API token"
                    description="Token with Workers AI permissions."
                >
                    <div className="flex items-center gap-1.5">
                        <input
                            type={showCloudflareKey ? "text" : "password"}
                            value={cloudflareApiToken}
                            onChange={(e) => updateSettings({ cloudflareApiToken: e.target.value })}
                            placeholder="Cloudflare API token"
                            className="h-7 w-48 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Cloudflare API token"
                        />
                        <button
                            type="button"
                            onClick={() => setShowCloudflareKey(!showCloudflareKey)}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/20 text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={showCloudflareKey ? "Hide Cloudflare token" : "Show Cloudflare token"}
                        >
                            {showCloudflareKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </button>
                    </div>
                </SettingRow>
                <SettingRow
                    label="Cloudflare model"
                    description="Workers AI model for Git assistant tasks."
                >
                    <input
                        type="text"
                        value={cloudflareModel}
                        onChange={(e) => updateSettings({ cloudflareModel: e.target.value })}
                        placeholder="@cf/meta/llama-3.1-8b-instruct"
                        className="h-7 w-56 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Cloudflare model"
                    />
                </SettingRow>
                <div className="py-2.5">
                    <a
                        href="https://developers.cloudflare.com/workers-ai/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-emerald-400/80 hover:text-emerald-400 transition-colors"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Cloudflare Workers AI setup guide
                    </a>
                </div>
            </SettingSection>

            <SettingSection title="Model">
                <SettingRow
                    label="Default model"
                    description="Choose the Gemini model for new conversations."
                >
                    <SegmentedControl
                        value={defaultAiModel}
                        options={modelOptions}
                        onChange={(v) => updateSettings({ defaultAiModel: v as GeminiModelId })}
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Autocomplete">
                <SettingRow
                    label="Enable AI SQL autocomplete"
                    description="Master switch for inline ghost text and AI suggestion dropdown."
                >
                    <Switch
                        checked={aiAutocompleteEnabled}
                        onCheckedChange={(v) => updateSettings({ aiAutocompleteEnabled: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Inline ghost text"
                    description="Show Cursor-style inline completion at the caret (Tab to accept)."
                >
                    <Switch
                        checked={aiInlineSuggestions}
                        onCheckedChange={(v) => updateSettings({ aiInlineSuggestions: v })}
                        disabled={!aiAutocompleteEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label="AI dropdown suggestions"
                    description="Include AI completions in the IntelliSense dropdown."
                >
                    <Switch
                        checked={aiDropdownSuggestions}
                        onCheckedChange={(v) => updateSettings({ aiDropdownSuggestions: v })}
                        disabled={!aiAutocompleteEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label="Next-action chips"
                    description="Show quick AI follow-up actions under the editor."
                >
                    <Switch
                        checked={aiNextActionSuggestions}
                        onCheckedChange={(v) => updateSettings({ aiNextActionSuggestions: v })}
                        disabled={!aiAutocompleteEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label="Completion API URL"
                    description="PgStudio worker URL for /complete (used by inline suggestions)."
                >
                    <input
                        value={aiCompletionUrl}
                        onChange={(e) => updateSettings({ aiCompletionUrl: e.target.value })}
                        placeholder="https://your-worker.workers.dev/complete"
                        className="h-7 w-72 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="AI completion API URL"
                    />
                </SettingRow>
                <SettingRow
                    label="AI Worker URL (advanced)"
                    description="Optional: base worker URL for non-completion features."
                >
                    <input
                        value={aiWorkerUrl}
                        onChange={(e) => updateSettings({ aiWorkerUrl: e.target.value })}
                        placeholder="https://your-worker.workers.dev"
                        className="h-7 w-72 rounded-md border border-border/40 bg-muted/20 px-2 text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="AI worker URL"
                    />
                </SettingRow>
            </SettingSection>

            <SettingSection title="Performance">
                <SettingRow
                    label="Minimum typed characters"
                    description="Wait for enough context before querying AI to reduce noise."
                >
                    <StepInput
                        value={aiSuggestionMinChars}
                        min={4}
                        max={24}
                        onChange={(v) => updateSettings({ aiSuggestionMinChars: v })}
                        format={(v) => `${v} chars`}
                    />
                </SettingRow>
                <SettingRow
                    label="Request throttle"
                    description="Minimum delay between AI requests while typing."
                >
                    <StepInput
                        value={aiSuggestionThrottleMs}
                        min={80}
                        max={1200}
                        step={20}
                        onChange={(v) => updateSettings({ aiSuggestionThrottleMs: v })}
                        format={(v) => `${v}ms`}
                    />
                </SettingRow>
                <SettingRow
                    label="Context window"
                    description="How much recent SQL is sent to AI for each completion."
                >
                    <StepInput
                        value={aiSuggestionContextWindowChars}
                        min={300}
                        max={3000}
                        step={100}
                        onChange={(v) => updateSettings({ aiSuggestionContextWindowChars: v })}
                        format={(v) => `${v}c`}
                    />
                </SettingRow>
                <SettingRow
                    label="Live latency chip"
                    description="Show real-time AI response time and cache/network source in the editor."
                >
                    <Switch
                        checked={aiShowSuggestionLatency}
                        onCheckedChange={(v) => updateSettings({ aiShowSuggestionLatency: v })}
                        disabled={!aiAutocompleteEnabled}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

function SecuritySection() {
    const [lockOn, setLockOn] = useState(false);
    const [sensitiveOn, setSensitiveOn] = useState(false);
    const [status, setStatus] = useState<BiometricStatusPayload | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [on, sensitive, st] = await Promise.all([
                    securityGetBiometricLock(),
                    securityGetBiometricSensitiveOps(),
                    biometricGetStatus(),
                ]);
                if (!cancelled) {
                    setLockOn(on);
                    setSensitiveOn(sensitive);
                    setStatus(st);
                }
            } catch {
                if (!cancelled) {
                    setLockOn(false);
                    setSensitiveOn(false);
                    setStatus({ kind: "unavailable", message: "Could not load security status." });
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const canEnable = status?.kind === "available";
    const statusNote = loading
        ? "Loading device security status…"
        : status?.kind === "available"
          ? "Touch ID, Face ID, and Windows Hello work on this device."
          : status?.kind === "unavailable"
            ? status.message ?? "Biometrics are not available."
            : status?.message ?? "Not supported on this platform.";

    const onToggleLaunch = async (enabled: boolean) => {
        if (enabled && !canEnable) {
            toast.error("Biometric authentication is not available on this device.");
            return;
        }
        try {
            await securitySetBiometricLock(enabled);
            setLockOn(enabled);
            toast.success(enabled ? "App lock enabled." : "App lock disabled.");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        }
    };

    const onToggleSensitive = async (enabled: boolean) => {
        if (enabled && !canEnable) {
            toast.error("Biometric authentication is not available on this device.");
            return;
        }
        try {
            await securitySetBiometricSensitiveOps(enabled);
            setSensitiveOn(enabled);
            toast.success(
                enabled
                    ? "Biometric confirmation enabled for destructive actions."
                    : "Biometric confirmation for destructive actions disabled.",
            );
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        }
    };

    const destructiveDescription =
        "Requires your fingerprint or device PIN (via the system prompt) before risky work: SQL that updates, deletes, alters, drops, or truncates; deleting many rows at once (10+); bulk inserts (50+ rows); dropping or truncating tables; major schema changes; dropping databases or indexes; committing sandbox transactions.";

    return (
        <div className="space-y-5">
            <SettingSection title="App lock">
                <SettingRow
                    label="Require biometrics at launch"
                    description={`${statusNote} Adds an unlock step when you open the app; it does not encrypt local data.`}
                >
                    <Switch
                        checked={lockOn}
                        onCheckedChange={(v) => void onToggleLaunch(v)}
                        disabled={loading || (!canEnable && !lockOn)}
                    />
                </SettingRow>
            </SettingSection>
            <SettingSection title="Destructive actions">
                <SettingRow
                    label="Confirm bulk deletes, updates & schema changes"
                    description={destructiveDescription}
                >
                    <Switch
                        checked={sensitiveOn}
                        onCheckedChange={(v) => void onToggleSensitive(v)}
                        disabled={loading || (!canEnable && !sensitiveOn)}
                    />
                </SettingRow>
            </SettingSection>
        </div>
    );
}

function AboutSection({
    onOpenSurvey,
    onOpenBetaFeedback,
}: {
    onOpenSurvey?: () => void;
    onOpenBetaFeedback?: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const isTauri = isTauriRuntime();
    const {
        status: updateStatus,
        latestVersion,
        lastCheckedAt,
        updateAvailable,
        openingStore,
        checkForUpdates,
        openAppStore,
    } = useUpdateStore();

    const isChecking = updateStatus === "checking";
    const updateDescription = lastCheckedAt
        ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}`
        : "Check for updates in the Mac App Store.";

    const info = [
        { label: "Version", value: APP_VERSION },
        { label: "Framework", value: "Next.js 16 + Tauri 2" },
        { label: "Runtime", value: "Rust + React 19" },
        { label: "Database", value: "PostgreSQL" },
    ];

    return (
        <div className="space-y-5">
            <SettingSection title="Application">
                <div className="py-4 flex items-start gap-4">
                    <Image src="/logo.png" alt="" width={40} height={40} className="h-10 w-10 rounded-xl object-contain shrink-0" />
                    <div>
                        <p className="font-semibold text-foreground">
                            {APP_NAME}
                        </p>
                        <p className="text-xs text-muted-foreground/60 mt-0.5">
                            A blazing-fast, modern PostgreSQL admin panel
                        </p>
                    </div>
                </div>
                {info.map(({ label, value }) => (
                    <div
                        key={label}
                        className="flex items-center justify-between py-2.5"
                    >
                        <span className="text-sm text-muted-foreground/70">{label}</span>
                        <Badge variant="secondary" className="font-mono text-xs">
                            {value}
                        </Badge>
                    </div>
                ))}
                <div className="flex items-center justify-between py-2.5">
                    <span className="text-sm text-muted-foreground/70">Build info</span>
                    <button
                        type="button"
                        onClick={() => {
                            const info = `${APP_NAME} v${APP_VERSION} — Next.js 16 + Tauri 2`;
                            navigator.clipboard.writeText(info);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                        }}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-foreground transition-colors"
                    >
                        {copied ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                            <span className="font-mono">Copy</span>
                        )}
                    </button>
                </div>
            </SettingSection>

            <SettingSection title="Notifications">
                <SettingRow
                    label="Enable notifications"
                    description="Show system notifications for alerts and updates."
                >
                    <NotificationsToggle />
                </SettingRow>
            </SettingSection>

            {isTauri && (
                <SettingSection title="Updates">
                    <SettingRow
                        label="App updates"
                        description={updateDescription}
                    >
                        <div className="flex items-center gap-2">
                            {updateAvailable && latestVersion ? (
                                <Badge className="font-mono text-xs">v{latestVersion} available</Badge>
                            ) : updateStatus === "up-to-date" ? (
                                <span className="text-xs text-muted-foreground">Up to date</span>
                            ) : null}
                            <Button
                                type="button"
                                size="sm"
                                className="gap-2"
                                onClick={() => {
                                    if (updateAvailable) {
                                        void openAppStore();
                                        return;
                                    }
                                    void checkForUpdates({ source: "manual" });
                                }}
                                disabled={isChecking || openingStore}
                            >
                                {isChecking || openingStore ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <ArrowUpRight className="h-3.5 w-3.5" />
                                )}
                                Update Now
                            </Button>
                        </div>
                    </SettingRow>
                </SettingSection>
            )}

            <SettingSection title="Support">
                <SettingRow
                    label="Report a bug"
                    description="Open the dedicated bug report page with screenshot attachments and Firebase tracking."
                >
                    <Link
                        href="/bug-report"
                        className="inline-flex items-center gap-1.5 text-xs text-emerald-400/80 hover:text-emerald-400 transition-colors"
                    >
                        Open bug report page
                        <ExternalLink className="h-3 w-3" />
                    </Link>
                </SettingRow>
                {onOpenSurvey && (
                    <SettingRow
                        label="Share your feedback"
                        description="Help us improve by answering a short survey about how you discovered the app and what you expect."
                    >
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={onOpenSurvey}
                        >
                            <MessageSquareText className="h-3.5 w-3.5" />
                            Take survey
                        </Button>
                    </SettingRow>
                )}
                {onOpenBetaFeedback && (
                    <SettingRow
                        label="Beta feedback"
                        description="We're in beta and shipping often — share ideas, feature requests, or report issues. Signed-in users only."
                    >
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={onOpenBetaFeedback}
                        >
                            <MessageSquare className="h-3.5 w-3.5" />
                            Give feedback
                        </Button>
                    </SettingRow>
                )}
            </SettingSection>

            <SettingSection title="Performance">
                <SettingRow
                    label="Connection pooling"
                    description="Connections are pooled via sqlx for optimal performance."
                >
                    <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        <span className="text-xs text-emerald-400 font-medium">Active</span>
                    </div>
                </SettingRow>
                <SettingRow
                    label="Query cache"
                    description="Schema metadata is cached in-memory for fast sidebar navigation."
                >
                    <div className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-xs text-amber-400 font-medium">Enabled</span>
                    </div>
                </SettingRow>
            </SettingSection>
        </div>
    );
}

// ── Main Dialog ───────────────────────────────────────────────────────────────

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When provided, shows a "Take survey" button in About that closes settings and opens the survey modal. */
    onOpenSurvey?: () => void;
    /** When provided, shows a "Give feedback" button in About that closes settings and opens the beta feedback dialog. */
    onOpenBetaFeedback?: () => void;
    /** Set by the native app menu to jump to a section when the dialog opens. */
    seedSection?: SettingsSection | null;
}

export function SettingsDialog({
    open,
    onOpenChange,
    onOpenSurvey,
    onOpenBetaFeedback,
    seedSection = null,
}: SettingsDialogProps) {
    const [activeSection, setActiveSection] = useState<SettingsSection>("appearance");
    const { resetSettings } = useSettingsStore();
    const { setTheme } = useTheme();
    const isDesktop = isTauriRuntime();
    const sections = useMemo(
        () => ALL_SECTIONS.filter((s) => s.id !== "security" || isDesktop),
        [isDesktop]
    );

    const handleReset = () => {
        resetSettings();
        setTheme("dark");
        if (isDesktop) {
            void securitySetBiometricLock(false).catch(() => {});
            void securitySetBiometricSensitiveOps(false).catch(() => {});
        }
        toast.success("Settings reset to defaults", { duration: 2000 });
    };

    useEffect(() => {
        if (!open || !seedSection) return;
        const id = requestAnimationFrame(() => setActiveSection(seedSection));
        return () => cancelAnimationFrame(id);
    }, [open, seedSection]);

    const displaySection: SettingsSection =
        isDesktop || activeSection !== "security" ? activeSection : "appearance";

    const renderSection = () => {
        switch (displaySection) {
            case "appearance": return <AppearanceSection />;
            case "editor": return <EditorSection />;
            case "data": return <DataSection />;
            case "query": return <QuerySection />;
            case "ai": return <AISection />;
            case "shortcuts": return <ShortcutsSection />;
            case "security": return <SecuritySection />;
            case "about": return (
                <AboutSection
                    onOpenSurvey={onOpenSurvey}
                    onOpenBetaFeedback={onOpenBetaFeedback}
                />
            );
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn(
                "max-w-[65vw] sm:max-w-7xl w-full h-[60vh] flex flex-col p-0 gap-0 overflow-hidden",
                "rounded-xl border-border/40 shadow-2xl"
            )}>
                <DialogTitle className="sr-only">Settings</DialogTitle>

                <div className="flex h-[520px]">
                    {/* Sidebar nav */}
                    <div className="w-44 shrink-0 border-r border-border/20 bg-muted/20 flex flex-col">
                        <div className="px-4 pt-4 pb-3 border-b border-border/20">
                            <p className="text-sm font-semibold text-foreground/90">Settings</p>
                        </div>
                        <nav className="flex-1 p-2 space-y-0.5">
                            {sections.map((section) => (
                                <button
                                    key={section.id}
                                    type="button"
                                    onClick={() => setActiveSection(section.id)}
                                    className={cn(
                                        "w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all text-left",
                                        displaySection === section.id
                                            ? "bg-background text-foreground shadow-sm font-medium"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                    )}
                                >
                                    <span className={cn(
                                        displaySection === section.id
                                            ? "text-emerald-400"
                                            : "text-muted-foreground/60"
                                    )}>
                                        {section.icon}
                                    </span>
                                    {section.label}
                                </button>
                            ))}
                        </nav>
                        <div className="p-2 border-t border-border/20">
                            <button
                                type="button"
                                onClick={handleReset}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-all"
                            >
                                <RotateCcw className="h-3 w-3" />
                                Reset defaults
                            </button>
                        </div>
                    </div>

                    {/* Content area */}

                    <div className="flex-1 flex flex-col min-w-0">
                        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border/20 shrink-0">
                            <span className="text-emerald-400">
                                {sections.find((s) => s.id === displaySection)?.icon}
                            </span>
                            <h2 className="text-sm font-semibold text-foreground/90 capitalize">
                                {displaySection}
                            </h2>
                        </div>

                        <ScrollArea className="flex-1 h-[calc(100%-52px)]">
                            <div className="p-5 space-y-5">
                                {renderSection()}
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
