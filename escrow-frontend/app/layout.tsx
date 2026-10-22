import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Escrow",
  description: "Funds locked on-chain, released by an AI verdict",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
