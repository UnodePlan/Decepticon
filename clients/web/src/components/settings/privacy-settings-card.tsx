"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";
import type { SettingsSnapshot, TelemetryMode } from "@/lib/system-settings";
import { EffectBadge } from "./settings-effect-badge";

const TELEMETRY_KEYS: Record<TelemetryMode, TranslationKey> = {
  off: "settings.privacy.telemetry.off",
  basic: "settings.privacy.telemetry.basic",
  research: "settings.privacy.telemetry.research",
};

export interface PrivacySettingsCardProps {
  snapshot: SettingsSnapshot;
}

/**
 * Startup-scoped privacy facts: the telemetry tier, the auth-method priority and
 * the Skillogy embedding model.
 *
 * None of these can be written by this API (`SETTINGS_READONLY_FIELDS`) — the agent
 * process, the telemetry sink and the embedding dimension all resolve them from
 * their own environment when they start — so the card reports the effective value
 * with a read-only badge and names the env var instead of offering a save control
 * that could never do anything.
 */
export function PrivacySettingsCard({ snapshot }: PrivacySettingsCardProps) {
  const { t } = useI18n();

  const rows: Array<{ id: string; label: string; help: string; value: string }> = [
    {
      id: "settings-privacy-telemetry",
      label: t("settings.privacy.telemetry"),
      help: t("settings.privacy.telemetry.help"),
      value: t(TELEMETRY_KEYS[snapshot.telemetryMode]),
    },
    {
      id: "settings-privacy-auth-priority",
      label: t("settings.privacy.authPriority"),
      help: t("settings.privacy.authPriority.help"),
      value:
        snapshot.authPriority.length > 0
          ? snapshot.authPriority.join(" → ")
          : t("settings.privacy.authPriority.empty"),
    },
    {
      id: "settings-privacy-embed-model",
      label: t("settings.privacy.embedModel"),
      help: t("settings.privacy.embedModel.help"),
      value: snapshot.skillogyEmbedModel || t("settings.deployment.unavailable"),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.privacy.title")}</span>
          <EffectBadge effect="readOnly" />
        </CardTitle>
        <CardDescription>{t("settings.privacy.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.map((row) => (
          <div key={row.id} id={row.id} className="space-y-1 rounded-lg border border-border/50 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="truncate font-mono text-xs">{row.value}</span>
            </div>
            <p className="text-xs text-muted-foreground">{row.help}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
