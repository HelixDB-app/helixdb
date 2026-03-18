"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/app-config";
import {
    Zap,
    Shield,
    Terminal,
    ArrowRight,
    CheckCircle2,
    Cpu,
    Lock,
    Activity,
    Search,
} from "lucide-react";

interface WelcomeScreenProps {
    onDismiss: () => void;
}

const features = [
    {
        icon: Cpu,
        title: "Rust-Powered Core",
        description:
            "Built on Rust for near-zero overhead. Queries execute at native speed with minimal memory footprint—no JVM, no GC pauses.",
        accent: "from-orange-500 to-amber-500",
        glow: "shadow-orange-500/20",
    },
    {
        icon: Zap,
        title: "Blazing Fast",
        description:
            "Sub-millisecond UI responses and instant schema introspection. Large tables render in a fraction of the time compared to Electron-based tools.",
        accent: "from-emerald-500 to-cyan-500",
        glow: "shadow-emerald-500/20",
    },
    {
        icon: Lock,
        title: "Privacy-first",
        description:
            "Credentials are stored on-device and connections are direct—no cloud relay. Optional crash/diagnostic reporting can be enabled for beta support.",
        accent: "from-violet-500 to-purple-500",
        glow: "shadow-violet-500/20",
    },
    {
        icon: Terminal,
        title: "Smart SQL Editor",
        description:
            "Monaco-powered editor with syntax highlighting, autocomplete, and inline error hints. Write and execute queries without leaving your flow.",
        accent: "from-sky-500 to-blue-500",
        glow: "shadow-sky-500/20",
    },
];

const advantages = [
    "10× faster startup than Electron-based tools",
    "Credentials never leave your machine",
    "Native OS performance, not a web wrapper",
    "Zero config—connect and explore instantly",
    "Full SQL editor with autocomplete",
    "Local PostgreSQL auto-detection",
];

export function WelcomeScreen({ onDismiss }: WelcomeScreenProps) {
    const [visible, setVisible] = useState(false);
    const [leaving, setLeaving] = useState(false);

    useEffect(() => {
        const t = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(t);
    }, []);

    const handleDismiss = () => {
        setLeaving(true);
        setTimeout(onDismiss, 500);
    };

    return (
        <div
            className={`fixed inset-0 z-50 flex flex-col overflow-auto bg-background transition-all duration-500 ease-in-out
                ${visible && !leaving ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4"}`}
        >
            {/* Ambient background orbs */}
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full bg-emerald-500/5 blur-3xl animate-orb-slow" />
                <div className="absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-cyan-500/5 blur-3xl animate-orb-slow-reverse" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[300px] w-[600px] rounded-full bg-violet-500/3 blur-3xl" />
                {/* Subtle grid */}
                <div
                    className="absolute inset-0 opacity-[0.03]"
                    style={{
                        backgroundImage:
                            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
                        backgroundSize: "48px 48px",
                    }}
                />
            </div>

            <div className="relative flex-1 flex flex-col items-center justify-start py-16 px-6">
                {/* Hero */}
                <div className="text-center max-w-2xl mx-auto animate-fade-up" style={{ animationDelay: "0ms" }}>
                    {/* Logo */}
                    <div className="flex justify-center mb-6">
                        <div className="relative">
                            <div className="absolute -inset-6 rounded-full bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 blur-2xl animate-pulse-slow" />
                            <img
                                src="/logo.png"
                                alt=""
                                className="relative h-20 w-20 rounded-2xl object-contain shadow-2xl shadow-emerald-500/20"
                            />
                        </div>
                    </div>

                    {/* Title */}
                    <h1 className="text-5xl font-extrabold tracking-tight mb-3">
                        <span className="bg-gradient-to-r from-emerald-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent bg-[length:200%] animate-gradient-x">
                            {APP_NAME}
                        </span>
                    </h1>

                    {/* Rust badge */}
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-400 mb-4">
                        <span className="text-base leading-none">🦀</span>
                        Powered by Rust
                    </div>

                    <p className="text-lg text-muted-foreground leading-relaxed">
                        A blazing-fast, secure PostgreSQL admin panel built for developers who value{" "}
                        <span className="text-foreground font-medium">speed</span>,{" "}
                        <span className="text-foreground font-medium">privacy</span>, and a{" "}
                        <span className="text-foreground font-medium">frictionless workflow</span>.
                    </p>
                </div>

                {/* Feature cards */}
                <div className="mt-12 grid gap-4 sm:grid-cols-2 max-w-3xl w-full mx-auto">
                    {features.map((feat, i) => (
                        <div
                            key={feat.title}
                            className="group relative rounded-xl border border-border/30 bg-card/40 p-5 backdrop-blur-sm transition-all duration-300 hover:border-border/60 hover:bg-card/60 animate-fade-up"
                            style={{ animationDelay: `${100 + i * 80}ms` }}
                        >
                            <div className="flex items-start gap-4">
                                <div
                                    className={`shrink-0 flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ${feat.accent} shadow-lg ${feat.glow} transition-transform duration-300 group-hover:scale-110`}
                                >
                                    <feat.icon className="h-5 w-5 text-white" />
                                </div>
                                <div>
                                    <h3 className="font-semibold text-sm text-foreground mb-1">
                                        {feat.title}
                                    </h3>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        {feat.description}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Why pgStudio section */}
                <div
                    className="mt-10 max-w-3xl w-full mx-auto rounded-xl border border-border/20 bg-card/20 p-6 animate-fade-up"
                    style={{ animationDelay: "420ms" }}
                >
                    <div className="flex items-center gap-2 mb-4">
                        <Activity className="h-4 w-4 text-emerald-400" />
                        <h2 className="text-sm font-semibold text-foreground">
                            Why {APP_NAME} over others?
                        </h2>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {advantages.map((adv) => (
                            <div key={adv} className="flex items-center gap-2.5">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                                <span className="text-xs text-muted-foreground">{adv}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Security note */}
                <div
                    className="mt-6 max-w-3xl w-full mx-auto flex items-start gap-3 rounded-xl border border-violet-500/20 bg-violet-500/5 px-5 py-4 animate-fade-up"
                    style={{ animationDelay: "500ms" }}
                >
                    <Shield className="h-4 w-4 shrink-0 text-violet-400 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-violet-300">Your data stays yours.</span>{" "}
                        {APP_NAME} connects directly to your database (no proxy). For beta support, you can optionally enable lightweight crash/diagnostic reporting—never credentials.
                    </p>
                </div>

                {/* CTA */}
                <div
                    className="mt-10 flex flex-col items-center gap-3 animate-fade-up"
                    style={{ animationDelay: "580ms" }}
                >
                    <Button
                        size="lg"
                        className="h-12 px-8 text-sm font-semibold bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white shadow-lg shadow-emerald-500/20 transition-all duration-200 hover:shadow-emerald-500/40 hover:scale-[1.02] active:scale-[0.98]"
                        onClick={handleDismiss}
                    >
                        Get Started
                        <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                    <p className="text-[11px] text-muted-foreground/50">
                        Free &amp; open source · No account required
                    </p>
                </div>
            </div>
        </div>
    );
}
