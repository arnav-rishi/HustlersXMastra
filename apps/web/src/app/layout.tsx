import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "LexGuard AI — Legal Intelligence Platform",
  description: "Enterprise AI-powered contract analysis, risk detection, and HITL compliance review.",
  keywords: ["legal AI", "contract analysis", "compliance", "risk detection"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar />
          <main className="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
