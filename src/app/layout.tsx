import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SerwistProvider } from "@serwist/turbopack/react";
import "./globals.css";
import "highlight.js/styles/github-dark.css";
import { AppShell } from "@/components/layout/AppShell";
import { ReactQueryProvider } from "@/components/providers/ReactQueryProvider";
import { AppMotionProvider } from "@/components/providers/AppMotionProvider";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { Toaster } from "@/components/ui/toaster";
import { BackgroundAiToastProvider } from "@/components/BackgroundAiToastProvider";
import { UndoKeyboardProvider } from "@/components/UndoKeyboardProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";
import { APP_DARK_BACKGROUND, APP_DARK_CHROME } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: APP_DARK_CHROME,
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Personal task & alert aggregation hub",
  applicationName: "Mission Control",
  manifest: "/api/manifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon-v4-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-v4-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icon-maskable-v4-192.png", sizes: "192x192", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Mission Control",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      style={{ backgroundColor: APP_DARK_BACKGROUND }}
    >
      <body className="min-h-full flex flex-col bg-[var(--background)] text-[var(--text-primary)]" style={{ backgroundColor: APP_DARK_BACKGROUND }}>
        <SerwistProvider swUrl="/serwist/sw.js">
        <ReactQueryProvider>
        <AppMotionProvider>
        <TooltipProvider>
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-[var(--accent)] focus:text-white focus:rounded-[var(--radius-md)] focus:text-sm focus:font-medium">
          Skip to main content
        </a>
        <AppShell>
          <ErrorBoundary viewName="App">
           {children}
          </ErrorBoundary>
        </AppShell>
        <PwaInstallPrompt />
        <BackgroundAiToastProvider />
        <UndoKeyboardProvider />
        <Toaster />
        </TooltipProvider>
        </AppMotionProvider>
        </ReactQueryProvider>
        </SerwistProvider>
      </body>
    </html>
  );
}
