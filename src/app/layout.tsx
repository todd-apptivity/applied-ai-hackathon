import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ninety",
  description: "A Clio matter you can read in ninety seconds.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        A fixed-height shell rather than a growing one. `min-h-full` let the
        body grow past the viewport, which meant a panel asking for `h-full` or
        `flex-1` had no definite height to resolve against and simply ran off
        the bottom of the screen. Bounding it here is what lets a page scroll
        its own regions — each one owns an `overflow-y-auto`, so the document
        itself never scrolls.
      */}
      <body className="flex h-dvh flex-col overflow-hidden">
        <nav className="flex shrink-0 items-center gap-5 border-b border-ink-border bg-ink px-6 py-3 font-sans text-sm text-ink-muted">
          <Link href="/" className="mr-2 font-serif text-lg font-semibold text-ink-foreground">
            Ninety
          </Link>
          <Link href="/matters" className="hover:text-ink-foreground">
            Cases
          </Link>
          <Link href="/chat" className="hover:text-ink-foreground">
            Case chat
          </Link>
          <Link href="/clio" className="ml-auto hover:text-ink-foreground">
            Clio connection
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
