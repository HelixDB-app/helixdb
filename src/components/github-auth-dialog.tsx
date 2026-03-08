"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useGitStore } from "@/stores/git-store";
import { githubStartOauth, githubExchangeCode } from "@/lib/tauri";
import {
    AlertCircle,
    Check,
    ExternalLink,
    Github,
    Loader2,
    LogOut,
    Shield,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractCodeFromCallback(url: string): string | null {
    try {
        // pgstudio://git/callback?code=<code>&state=pgstudio_git
        const raw = url.replace("pgstudio://git/callback", "http://localhost/cb");
        const parsed = new URL(raw);
        return parsed.searchParams.get("code");
    } catch {
        return null;
    }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GithubAuthDialog() {
    const { showAuthDialog, setShowAuthDialog, githubUser, setGithubUser, signOutGithub, checkGithubAuth, refreshAll } =
        useGitStore();

    const [step, setStep] = useState<"idle" | "waiting" | "success" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isSigningOut, setIsSigningOut] = useState(false);

    // Re-check auth state whenever dialog opens
    useEffect(() => {
        if (showAuthDialog) {
            checkGithubAuth();
            setStep("idle");
            setErrorMsg(null);
        }
    }, [showAuthDialog, checkGithubAuth]);

    // Listen for the deep-link callback from GitHub OAuth
    useEffect(() => {
        if (!showAuthDialog || step !== "waiting") return;

        let unlisten: (() => void) | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const setup = async () => {
            unlisten = await listen<string>("pgstudio-git-callback", async (event) => {
                const code = extractCodeFromCallback(event.payload);
                if (!code) {
                    setStep("error");
                    setErrorMsg("OAuth callback did not contain a code. Please try again.");
                    return;
                }
                try {
                    const user = await githubExchangeCode(code);
                    setGithubUser(user);
                    // Also store token in store state
                    await checkGithubAuth();
                    await refreshAll({ fetchRemote: true });
                    setStep("success");
                } catch (e: unknown) {
                    setStep("error");
                    setErrorMsg(String(e));
                }
            });

            // Auto-cancel after 5 minutes
            timeoutId = setTimeout(() => {
                if (step === "waiting") {
                    setStep("error");
                    setErrorMsg("Authorization timed out. Please try again.");
                }
            }, 5 * 60 * 1000);
        };

        setup();

        return () => {
            unlisten?.();
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, [showAuthDialog, step, setGithubUser, checkGithubAuth, refreshAll]);

    const handleAuthorize = async () => {
        setStep("waiting");
        setErrorMsg(null);
        try {
            await githubStartOauth();
        } catch (e: unknown) {
            setStep("error");
            setErrorMsg(String(e));
        }
    };

    const handleSignOut = async () => {
        setIsSigningOut(true);
        setErrorMsg(null);
        try {
            await signOutGithub();
            await refreshAll({ fetchRemote: true });
            setStep("idle");
        } catch (e: unknown) {
            setStep("error");
            setErrorMsg(String(e));
        } finally {
            setIsSigningOut(false);
        }
    };

    const handleClose = () => {
        setShowAuthDialog(false);
        setStep("idle");
        setErrorMsg(null);
    };

    return (
        <Dialog open={showAuthDialog} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Github className="h-4 w-4" />
                        GitHub Integration
                    </DialogTitle>
                    <DialogDescription>
                        Connect your GitHub account to push code, manage repositories, and create pull requests.
                    </DialogDescription>
                </DialogHeader>

                {/* Connected state */}
                {githubUser && step !== "waiting" ? (
                    <div className="space-y-4">
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                            <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                            <span className="text-sm text-emerald-300 font-medium">Connected to GitHub</span>
                        </div>

                        <div className="flex items-center gap-3">
                            <Avatar className="h-10 w-10">
                                <AvatarImage src={githubUser.avatar_url} alt={githubUser.login} />
                                <AvatarFallback>{githubUser.login[0]?.toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div>
                                <p className="text-sm font-medium">{githubUser.name ?? githubUser.login}</p>
                                <p className="text-xs text-muted-foreground">@{githubUser.login}</p>
                                {githubUser.email && (
                                    <p className="text-xs text-muted-foreground">{githubUser.email}</p>
                                )}
                            </div>
                            <Badge variant="outline" className="ml-auto text-emerald-400 border-emerald-400/30 text-[10px]">
                                Active
                            </Badge>
                        </div>

                        <Separator />

                        <div className="text-xs text-muted-foreground space-y-1">
                            <div className="flex items-center gap-1.5">
                                <Shield className="h-3 w-3" />
                                <span>Token stored securely in OS keychain</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Check className="h-3 w-3" />
                                <span>Permissions: repo, user:email</span>
                            </div>
                        </div>
                    </div>
                ) : step === "waiting" ? (
                    /* Waiting for browser auth */
                    <div className="flex flex-col items-center gap-4 py-4">
                        <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-medium">Waiting for GitHub…</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Complete authorization in the browser window that just opened.
                            </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
                            Cancel
                        </Button>
                    </div>
                ) : step === "success" ? (
                    /* Success flash */
                    <div className="flex flex-col items-center gap-4 py-4">
                        <div className="h-12 w-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                            <Check className="h-6 w-6 text-emerald-400" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-emerald-300">Authorization successful!</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                You are now connected as <strong>@{githubUser?.login}</strong>
                            </p>
                        </div>
                    </div>
                ) : step === "error" ? (
                    /* Error state */
                    <div className="space-y-3">
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                            <p className="text-sm text-destructive">{errorMsg ?? "Authorization failed"}</p>
                        </div>
                        {(errorMsg?.includes("GITHUB_CLIENT_ID") || errorMsg?.includes("GITHUB_CLIENT_SECRET")) && (
                            <div className="text-xs text-muted-foreground p-3 bg-muted/30 rounded-lg space-y-1.5">
                                <p className="font-medium text-foreground/70">Add these to a <code className="font-mono">.env</code> file:</p>
                                <ul className="list-disc list-inside text-[10px] mb-1">
                                    <li>Development: project root <code className="font-mono">.env</code></li>
                                    <li>Installed app (e.g. TestFlight): <code className="font-mono">~/Library/Application Support/pgstudio/.env</code></li>
                                </ul>
                                <pre className="font-mono text-[10px] bg-muted/50 rounded p-2 select-all">
{`GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_secret`}
                                </pre>
                                <p className="text-[10px]">
                                    Get these from{" "}
                                    <a
                                        href="#"
                                        className="text-sky-400 underline"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            invoke("open_path", { path: "https://github.com/settings/developers" }).catch(() => {});
                                        }}
                                    >
                                        github.com/settings/developers
                                    </a>{" "}
                                    → your OAuth App. Set the callback URL to{" "}
                                    <code className="font-mono text-[10px]">pgstudio://git/callback</code>, then restart the app.
                                </p>
                            </div>
                        )}
                    </div>
                ) : (
                    /* Idle — not connected */
                    <div className="space-y-4">
                        <div className="p-4 rounded-lg bg-muted/30 space-y-3">
                            <div className="flex items-center gap-3">
                                <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center">
                                    <Github className="h-4 w-4" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium">Connect via GitHub OAuth</p>
                                    <p className="text-xs text-muted-foreground">Secure authorization — no password needed</p>
                                </div>
                            </div>
                            <div className="text-xs text-muted-foreground space-y-1">
                                <div className="flex items-center gap-1.5">
                                    <Shield className="h-3 w-3" />
                                    <span>Your token is stored in the OS keychain, never on disk</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <ExternalLink className="h-3 w-3" />
                                    <span>Clicking authorize opens GitHub in your default browser</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <DialogFooter className="gap-2">
                    {githubUser && step !== "waiting" ? (
                        <>
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 text-destructive hover:text-destructive hover:border-destructive/40"
                                onClick={handleSignOut}
                                disabled={isSigningOut}
                            >
                                {isSigningOut
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <LogOut className="h-3.5 w-3.5" />}
                                Disconnect
                            </Button>
                            <Button size="sm" onClick={handleClose}>Done</Button>
                        </>
                    ) : step === "success" ? (
                        <Button size="sm" onClick={handleClose}>Done</Button>
                    ) : step === "error" ? (
                        <>
                            <Button variant="outline" size="sm" onClick={() => setStep("idle")}>Back</Button>
                            <Button size="sm" onClick={handleAuthorize}>Try again</Button>
                        </>
                    ) : step !== "waiting" ? (
                        <>
                            <Button variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
                            <Button size="sm" className="gap-1.5" onClick={handleAuthorize}>
                                <Github className="h-3.5 w-3.5" />
                                Authorize with GitHub
                            </Button>
                        </>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
