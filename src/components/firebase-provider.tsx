"use client";

import { useEffect } from "react";

/**
 * Client-only wrapper that lazy-initializes Firebase Analytics and crash reporting after hydration.
 * Dynamic-imports the firebase module so no Firebase code is in the main bundle.
 */
export function FirebaseProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    import("@/lib/firebase").then((m) => m.initFirebase());
  }, []);
  return <>{children}</>;
}
