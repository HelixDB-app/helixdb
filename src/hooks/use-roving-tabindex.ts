"use client";

import { useState, useCallback, useRef, useEffect } from "react";

export interface UseRovingTabIndexOptions {
    /** Total number of focusable items */
    count: number;
    /** Initial focused index (-1 for none) */
    initialIndex?: number;
    /** Orientation for arrow keys: "horizontal" | "vertical" */
    orientation?: "horizontal" | "vertical";
    /** Whether to wrap at ends (e.g. ArrowDown on last goes to first) */
    wrap?: boolean;
}

export interface UseRovingTabIndexReturn {
    /** Index of the item that should have tabIndex={0}; others use tabIndex={-1} */
    focusedIndex: number;
    /** Set focused index (e.g. when user tabs in) */
    setFocusedIndex: (index: number) => void;
    /** Props to spread onto the container: onKeyDown and optionally role/aria */
    getContainerProps: (opts?: { role?: string; "aria-label"?: string }) => {
        onKeyDown: (e: React.KeyboardEvent) => void;
        role?: string;
        "aria-label"?: string;
    };
    /** Get props for the i-th item: tabIndex, onFocus, ref */
    getItemProps: (index: number) => {
        tabIndex: number;
        onFocus: () => void;
        ref: (el: HTMLElement | null) => void;
    };
}

/**
 * Hook for roving tabindex and arrow-key navigation in a list (tablist, tree, grid row).
 * One item has tabIndex={0}, the rest tabIndex={-1}. Arrow keys move focus.
 */
export function useRovingTabIndex({
    count,
    initialIndex = 0,
    orientation = "horizontal",
    wrap = false,
}: UseRovingTabIndexOptions): UseRovingTabIndexReturn {
    const [focusedIndex, setFocusedIndexState] = useState(initialIndex);
    const itemRefs = useRef<(HTMLElement | null)[]>([]);

    const setFocusedIndex = useCallback((index: number) => {
        setFocusedIndexState((prev) => {
            const next = Math.max(-1, Math.min(count - 1, index));
            return next === prev ? prev : next;
        });
    }, [count]);

    useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, count);
    }, [count]);

    const move = useCallback(
        (delta: number) => {
            if (count <= 0) return;
            setFocusedIndexState((prev) => {
                let next = prev + delta;
                if (wrap) {
                    next = ((next % count) + count) % count;
                } else {
                    next = Math.max(0, Math.min(count - 1, next));
                }
                const el = itemRefs.current[next];
                if (el) el.focus();
                return next;
            });
        },
        [count, wrap]
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const isHorizontal = orientation === "horizontal";
            const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";
            const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
            if (e.key === prevKey) {
                e.preventDefault();
                move(-1);
            } else if (e.key === nextKey) {
                e.preventDefault();
                move(1);
            } else if (e.key === "Home") {
                e.preventDefault();
                setFocusedIndex(0);
                itemRefs.current[0]?.focus();
            } else if (e.key === "End") {
                e.preventDefault();
                const last = count - 1;
                setFocusedIndex(last);
                itemRefs.current[last]?.focus();
            }
        },
        [orientation, move, count, setFocusedIndex]
    );

    const getContainerProps = useCallback(
        (opts?: { role?: string; "aria-label"?: string }) => ({
            onKeyDown,
            ...(opts && { role: opts.role, "aria-label": opts["aria-label"] }),
        }),
        [onKeyDown]
    );

    const getItemProps = useCallback(
        (index: number) => ({
            tabIndex: focusedIndex === index ? 0 : -1,
            onFocus: () => setFocusedIndexState(index),
            ref: (el: HTMLElement | null) => {
                itemRefs.current[index] = el;
            },
        }),
        [focusedIndex]
    );

    return {
        focusedIndex,
        setFocusedIndex,
        getContainerProps,
        getItemProps,
    };
}
