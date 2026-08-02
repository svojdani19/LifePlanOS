import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LifePlanOS — the operating system for life care planning",
  description:
    "AI-assisted life care planning for planning firms, rehab & nurse consultants, physician planners, and law firms. Defensibility over damages.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
