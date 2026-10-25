import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrustForge",
  description: "Funds locked on-chain, released by an AI verdict",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var d=document.documentElement;var t=localStorage.getItem('theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}d.dataset.theme=t;if(sessionStorage.getItem('intro')||matchMedia('(prefers-reduced-motion: reduce)').matches){d.dataset.intro='seen'}}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
