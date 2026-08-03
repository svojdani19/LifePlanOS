import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// The design system's sans stack resolves var(--font-sans) — defined here via
// next/font. Without this the CSS variable is undefined and font-family
// falls back to the browser default (serif).
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "LifePlanOS — the operating system for life care planning",
  description:
    "AI-assisted life care planning for planning firms, rehab & nurse consultants, physician planners, and law firms. Defensibility over damages.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
