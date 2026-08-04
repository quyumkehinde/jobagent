import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "JobAgent",
  description: "Your job search, automated",
};

const nav = [
  { href: "/", label: "Today" },
  { href: "/jobs", label: "Jobs" },
  { href: "/board", label: "Pipeline" },
  { href: "/analytics", label: "Analytics" },
  { href: "/profile", label: "Profile" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-zinc-950 text-zinc-100 font-sans">
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-zinc-800 p-4 flex flex-col gap-1 sticky top-0 h-screen">
            <div className="text-lg font-bold mb-4 px-2">
              Job<span className="text-emerald-400">Agent</span>
            </div>
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-2 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                {n.label}
              </Link>
            ))}
          </aside>
          <main className="flex-1 p-6 max-w-6xl">{children}</main>
        </div>
      </body>
    </html>
  );
}
