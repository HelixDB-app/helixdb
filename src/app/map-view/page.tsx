"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const MapViewContent = dynamic(
    () => import("./map-view-content").then((m) => m.MapViewContent),
    { ssr: false, loading: () => (
        <div className="flex h-screen items-center justify-center bg-background">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
        </div>
    ) }
);

export default function MapViewPage() {
    return <MapViewContent />;
}
