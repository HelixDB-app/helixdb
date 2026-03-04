import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    environmentBadgeClass,
    formatEnvironmentLabel,
} from "@/lib/connection-metadata";
import type { ConnectionEnvironment } from "@/lib/types";

interface ConnectionEnvBadgeProps {
    environment?: ConnectionEnvironment | string | null;
    className?: string;
    compact?: boolean;
}

export function ConnectionEnvBadge({
    environment,
    className,
    compact = false,
}: ConnectionEnvBadgeProps) {
    return (
        <Badge
            variant="outline"
            className={cn(
                "font-semibold",
                compact ? "h-4 px-1.5 text-[9px]" : "h-5 px-2 text-[10px]",
                environmentBadgeClass(environment),
                className
            )}
        >
            {formatEnvironmentLabel(environment)}
        </Badge>
    );
}
