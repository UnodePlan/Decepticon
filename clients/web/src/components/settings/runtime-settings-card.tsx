"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALE_LABELS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { SettingsSnapshot } from "@/lib/system-settings";
import type { SettingsDraft } from "@/lib/settings-form";
import { EffectBadge, type EffectBadgeKind } from "./settings-effect-badge";

export interface RuntimeSettingsCardProps {
  draft: SettingsDraft;
  onChange: (patch: Partial<SettingsDraft>) => void;
}

/**
 * Console-level runtime defaults.
 *
 * The language default is read by the next page request. The LLM timeout/retry pair
 * used to sit here as editable rows that nothing consumed; they are startup-scoped
 * values (`DECEPTICON_LLM__TIMEOUT` / `DECEPTICON_LLM__MAX_RETRIES`, resolved by the
 * agent process itself) and are now reported by {@link StartupSettingsCard} instead,
 * so this card never offers a control that a save could not apply.
 */
export function RuntimeSettingsCard({ draft, onChange }: RuntimeSettingsCardProps) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.runtime.title")}</CardTitle>
        <CardDescription>{t("settings.runtime.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-language">{t("settings.runtime.language")}</Label>
            <EffectBadge effect="nextRequest" />
          </div>
          <Select
            value={draft.language}
            onValueChange={(value) => onChange({ language: (value ?? "en") as SettingsDraft["language"] })}
          >
            <SelectTrigger id="settings-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(LOCALE_LABELS) as Array<[SettingsDraft["language"], string]>).map(
                ([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.runtime.language.help")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export interface StartupSettingsCardProps {
  snapshot: SettingsSnapshot;
}

/**
 * Read-only deployment facts resolved at startup; never patched from the UI.
 *
 * Every row here is consumed by a process this dashboard cannot write to: the agent
 * core reads the profile / timeout / retries / extra-header names from its own
 * environment at model construction, and the workspace root comes from
 * `WORKSPACE_PATH` for the PTY and the file APIs alike. An editable row for any of
 * them would be a knob with no consumer — exactly the "saved but never applied" trap
 * this card exists to prevent.
 */
export function StartupSettingsCard({ snapshot }: StartupSettingsCardProps) {
  const { t } = useI18n();

  const profileLabels: Record<SettingsSnapshot["modelProfile"], string> = {
    eco: t("settings.deployment.profile.eco"),
    max: t("settings.deployment.profile.max"),
    test: t("settings.deployment.profile.test"),
  };

  const authLabels: Record<SettingsSnapshot["authMode"], string> = {
    password: t("settings.deployment.auth.password"),
    disabled: t("settings.deployment.auth.disabled"),
    unconfigured: t("settings.deployment.auth.unconfigured"),
  };

  const rows: Array<{ id: string; label: string; value: string; help?: string; effect: EffectBadgeKind }> = [
    {
      id: "settings-deployment-auth",
      label: t("settings.deployment.authMode"),
      value: authLabels[snapshot.authMode],
      effect: "restart",
    },
    {
      id: "settings-deployment-database",
      label: t("settings.deployment.database"),
      value: snapshot.databaseConfigured
        ? t("settings.deployment.configured")
        : t("settings.deployment.notConfigured"),
      effect: "restart",
    },
    {
      id: "settings-deployment-port",
      label: t("settings.deployment.webPort"),
      value: snapshot.deploymentWebPort || t("settings.deployment.unavailable"),
      effect: "restart",
    },
    {
      id: "settings-deployment-workspace",
      label: t("settings.runtime.workspace"),
      value: snapshot.workspacePath || t("settings.deployment.unavailable"),
      // The row is never read at all: the PTY, engagement creation and the file
      // APIs take the root from `WORKSPACE_PATH`, so this is a report — which is
      // why the field is rejected by `PUT` alongside the other startup facts.
      help: t("settings.runtime.workspace.help"),
      effect: "readOnly",
    },
    {
      id: "settings-deployment-profile",
      label: t("settings.deployment.modelProfile"),
      value: profileLabels[snapshot.modelProfile],
      help: t("settings.deployment.envOnly.help"),
      effect: "readOnly",
    },
    {
      id: "settings-deployment-timeout",
      label: t("settings.deployment.timeout"),
      value: String(snapshot.llmTimeoutSeconds),
      help: t("settings.deployment.envOnly.help"),
      effect: "readOnly",
    },
    {
      id: "settings-deployment-retries",
      label: t("settings.deployment.retries"),
      value: String(snapshot.llmMaxRetries),
      help: t("settings.deployment.envOnly.help"),
      effect: "readOnly",
    },
    {
      id: "settings-deployment-headers",
      label: t("settings.deployment.extraHeaders"),
      value:
        snapshot.llmExtraHeaderNames.length > 0
          ? snapshot.llmExtraHeaderNames.join(", ")
          : t("settings.deployment.headersEmpty"),
      help: t("settings.deployment.extraHeaders.help"),
      effect: "readOnly",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.deployment.title")}</CardTitle>
        <CardDescription>{t("settings.deployment.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.map((row) => (
          <div key={row.id} id={row.id} className="space-y-1 rounded-lg border border-border/50 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-xs">{row.value}</span>
                <EffectBadge effect={row.effect} />
              </span>
            </div>
            {row.help ? <p className="text-xs text-muted-foreground">{row.help}</p> : null}
          </div>
        ))}
        <p className="pt-1 text-xs text-muted-foreground">{t("settings.deployment.restartNote")}</p>
      </CardContent>
    </Card>
  );
}
