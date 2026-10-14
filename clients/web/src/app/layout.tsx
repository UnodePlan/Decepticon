import type { Metadata } from "next";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { browserConfig } from "@/lib/browser-config";
import { BrowserConfigProvider } from "@/lib/browser-config-context";
import { HTML_LANG, LOCALE_STORAGE_KEY, normalizeLocale } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n-context";
import { readSettingsSnapshot } from "@/lib/system-settings-store";
import type { SettingsSnapshot } from "@/lib/system-settings";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  title: "Decepticon — Autonomous Red Team Platform",
  description:
    "AI-powered autonomous red team testing framework with real-time attack monitoring and vulnerability management.",
  icons: {
    icon: "/logo.png",
  },
};

const LANGUAGE_READ_TIMEOUT_MS = 1_500;

/**
 * Settings the dashboard has stored, or `null` when there is no usable row.
 *
 * Runs on every page render, so it is bounded and total: an unreachable or
 * not-yet-migrated database must degrade to the deployment default instead of
 * stalling the response or taking the page down. The read's own rejection is
 * handled before the race, so a late failure never surfaces as an unhandled
 * rejection.
 */
async function savedSettings(): Promise<SettingsSnapshot | null> {
  const stored = readSettingsSnapshot().catch(() => null);
  // The timer is left to expire on its own: it settles a race that has already
  // finished, so clearing it would only buy back a sleeping 1.5s handle.
  const expired = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), LANGUAGE_READ_TIMEOUT_MS),
  );
  return Promise.race([stored, expired]);
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.ReactNode> {
  await connection();
  // Operator choice (cookie) wins, then the dashboard's saved language, then
  // the deployment default (DECEPTICON_LANGUAGE); anything unsupported falls
  // back to English. The saved row is read defensively — a database that is
  // unreachable or not yet migrated must degrade to the env default rather
  // than take every page down with it.
  const cookieLocale = (await cookies()).get(LOCALE_STORAGE_KEY)?.value;
  // Read unconditionally: the saved endpoints apply to every visitor, and the
  // read is one bounded query. A failed read yields `null` and changes nothing.
  const stored = await savedSettings();
  const storedLanguage = cookieLocale ? null : stored?.language ?? null;
  const locale = normalizeLocale(cookieLocale ?? storedLanguage ?? process.env.DECEPTICON_LANGUAGE);
  // Saved endpoint overrides win over the deployment values; `undefined` keeps
  // the env/default pair, so a missing row changes nothing.
  const config = browserConfig(process.env, stored ?? undefined);

  return (
    <html
      lang={HTML_LANG[locale]}
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <BrowserConfigProvider config={config}>
          <I18nProvider initialLocale={locale}>
            <TooltipProvider>{children}</TooltipProvider>
          </I18nProvider>
        </BrowserConfigProvider>
      </body>
    </html>
  );
}
