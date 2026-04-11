import type { Metadata, Viewport } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { FirebaseProvider } from "@/components/firebase-provider";
import { PosthogAppProvider } from "@/components/posthog-provider";
import { PosthogAuthBridge } from "@/components/posthog-auth-bridge";
import { NotificationProvider } from "@/components/notification-provider";
import { NotificationRTDBProvider } from "@/components/notification-rtdb-provider";
import { SubscriptionProvider } from "@/components/subscription-provider";
import { WhatsNewModal } from "@/components/whats-new-modal";
import { AppUpdateManager } from "@/components/app-update-manager";
import { NetworkStatusProvider } from "@/components/network-status-provider";
import { AppDebugLogger } from "@/components/app-debug-logger";
import { AppSplash } from "@/components/app-splash";
import { DesktopMenuBridge } from "@/components/desktop-menu-bridge";
import { WebAccountHashBridge } from "@/components/web-account-hash-bridge";
import { WebAuthReturnSync } from "@/components/web-auth-return-sync";
import { ErrorBoundary } from "@/components/error-boundary";
import { TrialProvider, TrialBanner, TrialGate } from "@/components/trial-banner";
import { APP_NAME, APP_TAGLINE } from "@/lib/app-config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description:
    "A blazing-fast, modern database admin panel powered by Rust and Next.js",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    type: "website",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: APP_NAME }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: APP_NAME,
  },
  formatDetection: { telephone: false },
};

/** Safari / iPad: correct scaling, status bar tint, and Add to Home Screen behavior. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f2f4" },
    { media: "(prefers-color-scheme: dark)", color: "#141414" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Hardcode the dark background before next-themes applies its class,
            preventing a flash of white on first paint. */}
        <style dangerouslySetInnerHTML={{ __html: `body{background-color:var(--background);}` }} />
      </head>
      <body className="font-sans antialiased">
        <AppSplash />
        <DesktopMenuBridge />
        <WebAccountHashBridge />
        <WebAuthReturnSync />
        <AppDebugLogger />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <PosthogAppProvider>
            <TooltipProvider delayDuration={200}>
              <FirebaseProvider>
                <PosthogAuthBridge />
                <NetworkStatusProvider>
                  <NotificationProvider>
                    <NotificationRTDBProvider>
                      <SubscriptionProvider>
                        <TrialProvider>
                          {/* <TrialGate /> */}
                          {/* <TrialBanner /> */}
                          <AppUpdateManager />
                          <WhatsNewModal />
                          <ErrorBoundary>
                            {children}
                          </ErrorBoundary>
                        </TrialProvider>
                      </SubscriptionProvider>
                    </NotificationRTDBProvider>
                  </NotificationProvider>
                </NetworkStatusProvider>
              </FirebaseProvider>
            </TooltipProvider>
            <Toaster />
          </PosthogAppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
