"use client";

import { useMemo } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { analyzeMigrationSql, conciergeChecklistMarkdown, type ConciergeItem } from "@/lib/schema-change-concierge";
import { Download } from "lucide-react";

function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function severityBadge(item: ConciergeItem) {
  const variant =
    item.severity === "block" ? "destructive" : item.severity === "warn" ? "secondary" : "outline";
  const label = item.severity.toUpperCase();
  return <Badge variant={variant} className="h-5 px-1.5 text-[10px]">{label}</Badge>;
}

export function SchemaChangeConciergeDialog({
  open,
  onOpenChange,
  sql,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sql: string;
}) {
  const items = useMemo(() => analyzeMigrationSql(sql), [sql]);
  const md = useMemo(() => conciergeChecklistMarkdown(items), [items]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Schema Change Concierge</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] rounded-md border border-border/30">
          <div className="p-4 space-y-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-lg border border-border/30 bg-card/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  {severityBadge(item)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                {item.suggestion ? (
                  <p className="mt-2 text-xs text-muted-foreground/80">
                    <span className="font-medium text-foreground/90">Suggestion:</span> {item.suggestion}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => downloadMarkdown(md, `schema-change-checklist-${Date.now()}.md`)}
          >
            <Download className="h-3.5 w-3.5" />
            Download checklist
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

