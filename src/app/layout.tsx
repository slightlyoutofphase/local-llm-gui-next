import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import type { ReactElement, ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./globals.css";

const sansFont = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Local LLM GUI",
  description: "Local-first GUI for GGUF chat models powered by llama-server.",
};

interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Renders the root application layout and mounts the client-side provider boundary.
 *
 * @param props Root layout props.
 * @param props.children The current route content.
 * @returns The application document shell.
 */
export default function RootLayout({ children }: Readonly<RootLayoutProps>): ReactElement {
  return (
    <html lang="en" className={`${sansFont.variable} ${monoFont.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
