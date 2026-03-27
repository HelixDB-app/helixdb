'use client'
import { CommandPalette } from "@/components/command-palette";
import { useState } from "react";

export default function DesktopSearchPage() {

    const [searchOpen, setSearchOpen] = useState(true);

    const setActiveView = (view: "query" | "data") => {
        setSearchOpen(false);
    };

    const openTab = (schema: string, table: string) => {
        setSearchOpen(false);
    };

    return   <CommandPalette
    open={searchOpen}
    onOpenChange={setSearchOpen}
    onNavigateToQuery={() => setActiveView("query")}
    onNavigateToData={() => setActiveView("data")}
    onNavigateToTable={(schema, table) => {
        setActiveView("data");
        openTab(schema, table);
    }}
/>
}
