"use client";

/**
 * Legacy `/settings` entry point.
 *
 * The settings screens were split into three routes (`/settings/models`,
 * `/settings/runtime`, `/settings/status`) so the rail can link to each one
 * directly. This page keeps old bookmarks and deep links working by pointing at
 * them instead of re-rendering every card: nothing here loads `/api/settings`,
 * so opening it can never discard or overwrite a draft on the real screens.
 */

import Link from "next/link";
import { Activity, Gauge, Settings } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";

interface SettingsEntry {
  href: string;
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
  icon: typeof Settings;
}

const SETTINGS_ENTRIES: SettingsEntry[] = [
  {
    href: "/settings/models",
    titleKey: "settings.page.models.title",
    subtitleKey: "settings.page.models.subtitle",
    icon: Settings,
  },
  {
    href: "/settings/runtime",
    titleKey: "settings.page.runtime.title",
    subtitleKey: "settings.page.runtime.subtitle",
    icon: Gauge,
  },
  {
    href: "/settings/status",
    titleKey: "settings.page.status.title",
    subtitleKey: "settings.page.status.subtitle",
    icon: Activity,
  },
];

export default function SettingsOverviewPage(): React.ReactNode {
  const { t } = useI18n();

  return (
    <SettingsPageShell titleKey="settings.title" subtitleKey="settings.subtitle">
      <div className="grid gap-4 sm:grid-cols-3">
        {SETTINGS_ENTRIES.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="rounded-lg border border-border/50 p-4 transition-colors hover:bg-accent"
          >
            <div className="flex items-center gap-2">
              <entry.icon className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">{t(entry.titleKey)}</span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t(entry.subtitleKey)}</p>
          </Link>
        ))}
      </div>
    </SettingsPageShell>
  );
}
