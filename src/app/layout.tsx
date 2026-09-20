import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import AppShell from "@/components/AppShell";
import LogProbe from "@/components/LogProbe";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "NyayaPack - packaged commodity inspection",
  description:
    "Inspect packaged commodities against Legal Metrology (Packaged Commodities) Rules, 2011. A prototype for SIH 2026.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${inter.className} ${inter.variable} antialiased`}>
        <LogProbe />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
