import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { FirebaseProvider } from "@/components/firebase-provider";
import { NotificationProvider } from "@/components/notification-provider";
import { NetworkStatusProvider } from "@/components/network-status-provider";
import { ErrorBoundary } from "@/components/error-boundary";
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
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
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
                  <ErrorBoundary>
                    {children}
                  </ErrorBoundary>
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
