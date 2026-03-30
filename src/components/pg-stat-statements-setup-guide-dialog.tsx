"use client";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { BookOpen, ExternalLink } from "lucide-react";

function GuideSection({
    title,
    children,
    className,
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section
            className={cn(
                "rounded-xl border border-border/50 bg-card/40 px-4 py-3 shadow-sm",
                className
            )}
        >
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
        </section>
    );
}

function CodeBlock({ children }: { children: string }) {
    return (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-border/40 bg-black/40 p-3 font-mono text-[11px] leading-snug text-emerald-200/90">
            {children.trim()}
        </pre>
    );
}

export function PgStatStatementsSetupGuideBody() {
    return (
        <div className="space-y-4 pr-2">
            <GuideSection title="Why pgStudio shows this">
                <p>
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">pg_stat_statements</code> is a
                    PostgreSQL module that must be{" "}
                    <strong className="text-foreground/90">loaded when the server starts</strong> (
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">shared_preload_libraries</code>
                    ), then enabled per database with{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">CREATE EXTENSION</code>. If the
                    extension row exists but the library was not preloaded, queries against the view fail until you fix
                    preload and restart.
                </p>
            </GuideSection>

            <GuideSection title="Fix it in three steps">
                <ol className="list-decimal space-y-1.5 pl-4">
                    <li>Add <code className="font-mono text-[11px]">pg_stat_statements</code> to shared preload (merge with existing libraries).</li>
                    <li>Restart PostgreSQL (or reboot / failover on managed services).</li>
                    <li>Run CREATE EXTENSION in this database (use the button in the banner).</li>
                </ol>
            </GuideSection>

            <GuideSection title="Local PostgreSQL">
                <p>Edit postgresql.conf (pgStudio may show the path under the banner), set preload, restart the service, then CREATE EXTENSION.</p>
                <CodeBlock>{`shared_preload_libraries = 'pg_stat_statements'`}</CodeBlock>
            </GuideSection>

            <GuideSection title="Docker">
                <p>Pass startup parameters so preload is set before the first start, then recreate the container if needed.</p>
                <CodeBlock>{`command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]`}</CodeBlock>
            </GuideSection>

            <GuideSection title="Azure Database for PostgreSQL (Flexible Server)">
                <p>
                    In the Azure portal, open your flexible server → <strong className="text-foreground/90">Server parameters</strong> →
                    search <code className="font-mono text-[11px]">shared_preload_libraries</code>. Append{" "}
                    <code className="font-mono text-[11px]">pg_stat_statements</code> to the value (comma-separated, preserve
                    existing entries such as other extensions). Save and restart if required, then run CREATE EXTENSION from
                    pgStudio.
                </p>
            </GuideSection>

            <GuideSection title="Amazon RDS">
                <p>
                    Use a DB parameter group: set <code className="font-mono text-[11px]">shared_preload_libraries</code> to
                    include pg_stat_statements, attach to the instance, reboot, then CREATE EXTENSION.
                </p>
            </GuideSection>

            <GuideSection title="Verify">
                <CodeBlock>{`SHOW shared_preload_libraries;
SELECT count(*) FROM pg_stat_statements;`}</CodeBlock>
            </GuideSection>

            <p className="text-[11px] text-muted-foreground/80">
                Full markdown guide (for sharing or printing):{" "}
                <code className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[10px]">docs/pg-stat-statements-setup.md</code>{" "}
                in the pgStudio repository.
            </p>
        </div>
    );
}

export type PgStatStatementsSetupGuideDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function PgStatStatementsSetupGuideDialog({ open, onOpenChange }: PgStatStatementsSetupGuideDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="flex max-h-[min(90vh,720px)] max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
                showCloseButton
            >
                <DialogHeader className="shrink-0 space-y-1 border-b border-border/40 bg-gradient-to-br from-cyan-950/40 via-background to-background px-5 py-4 text-left">
                    <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
                            <BookOpen className="h-4 w-4" />
                        </div>
                        <DialogTitle className="text-base">pg_stat_statements setup</DialogTitle>
                    </div>
                    <DialogDescription className="text-left text-xs">
                        Why it fails on some servers and how to enable it on local, Docker, Azure Flexible Server, and RDS.
                    </DialogDescription>
                </DialogHeader>
                <ScrollArea className="max-h-[min(72vh,560px)] px-5 py-4">
                    <PgStatStatementsSetupGuideBody />
                </ScrollArea>
                <div className="flex shrink-0 justify-end gap-2 border-t border-border/40 bg-card/30 px-5 py-3">
                    <Button type="button" variant="outline" size="sm" className="h-8" asChild>
                        <a
                            href="https://www.postgresql.org/docs/current/pgstatstatements.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="gap-1.5"
                        >
                            PostgreSQL docs
                            <ExternalLink className="h-3.5 w-3.5 opacity-70" />
                        </a>
                    </Button>
                    <Button type="button" variant="default" size="sm" className="h-8" onClick={() => onOpenChange(false)}>
                        Done
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
