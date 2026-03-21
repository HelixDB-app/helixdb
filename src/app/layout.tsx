import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { FirebaseProvider } from "@/components/firebase-provider";
import { NotificationProvider } from "@/components/notification-provider";
import { NotificationRTDBProvider } from "@/components/notification-rtdb-provider";
import { SubscriptionProvider } from "@/components/subscription-provider";
import { WhatsNewModal } from "@/components/whats-new-modal";
import { AppUpdateManager } from "@/components/app-update-manager";
import { NetworkStatusProvider } from "@/components/network-status-provider";
import { AppDebugLogger } from "@/components/app-debug-logger";
import { AppSplash } from "@/components/app-splash";
import { DesktopMenuBridge } from "@/components/desktop-menu-bridge";
import { ErrorBoundary } from "@/components/error-boundary";
import { TrialProvider, TrialBanner, TrialGate } from "@/components/trial-banner";
import { APP_NAME, APP_TAGLINE } from "@/lib/app-config";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description:
    "A blazing-fast, modern database admin panel powered by Rust and Next.js",
  icons: { icon: "/logo.png" },
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
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <AppSplash />
        <DesktopMenuBridge />
        <AppDebugLogger />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={200}>
            <FirebaseProvider>
              <NetworkStatusProvider>
                <NotificationProvider>
                  <NotificationRTDBProvider>
                    <SubscriptionProvider>
                      <TrialProvider>
                        <TrialGate />
                        <TrialBanner />
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
        </ThemeProvider>
      </body>
    </html>
  );
}
