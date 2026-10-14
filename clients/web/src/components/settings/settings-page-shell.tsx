"use client";

/**
 * The chrome every settings screen shares: the page heading and, for editable
 * screens, the save/discard bar plus the load-failure alert.
 *
 * Keeping it here means the three routes cannot drift apart in wording or in
 * how a failed load is reported.
 */

import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";
import type { SaveStatus } from "./use-settings-draft";

export interface SettingsPageShellProps {
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
  children: React.ReactNode;
}

/** Heading + body of a settings screen; no data of its own. */
export function SettingsPageShell({ titleKey, subtitleKey, children }: SettingsPageShellProps) {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t(titleKey)}</h1>
        <p className="text-sm text-muted-foreground">{t(subtitleKey)}</p>
      </div>
      {children}
    </div>
  );
}

export interface SettingsFormBarProps {
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  saveStatus: SaveStatus;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * Sync state + save/discard actions for an editable screen.
 *
 * The status slot reports exactly one thing at a time, in priority order:
 * a failed save, unsaved edits, a successful save, or "matches the saved
 * values" — the same wording the single settings page used before the split.
 */
export function SettingsFormBar({
  loading,
  dirty,
  saving,
  saveStatus,
  onDiscard,
  onSave,
}: SettingsFormBarProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">{t("settings.loading")}</span>
          </>
        ) : saveStatus?.kind === "error" ? (
          <span role="status" className="text-red-400">{saveStatus.message}</span>
        ) : dirty ? (
          <span role="status" className="text-amber-400">{t("settings.unsaved")}</span>
        ) : saveStatus?.kind === "saved" ? (
          <span role="status" className="text-emerald-400">{saveStatus.message}</span>
        ) : (
          <span className="text-muted-foreground">{t("settings.status.synced")}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
          {t("settings.action.discard")}
        </Button>
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {saving ? t("settings.action.saving") : t("settings.action.save")}
        </Button>
      </div>
    </div>
  );
}

export interface SettingsLoadErrorProps {
  /** Localized reason returned by the page's loader. */
  message: string;
  onRetry: () => void;
}

/** Load failure with a retry affordance, never a silent empty form. */
export function SettingsLoadError({ message, onRetry }: SettingsLoadErrorProps) {
  const { t } = useI18n();

  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{t("settings.loadError")} — {message}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("settings.action.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Centered spinner for a screen whose content is still loading. */
export function SettingsLoading() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}
