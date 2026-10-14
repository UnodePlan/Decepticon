"use client";

/**
 * Runtime settings screen: language/timeout/retry defaults, the spend and
 * approval guardrails, the endpoints the console dials, the startup-scoped
 * privacy facts, and the read-only deployment facts.
 *
 * Split out of the former single settings page so the rail can link straight to
 * it; it loads only the settings snapshot.
 */

import { GuardrailSettingsCard } from "@/components/settings/guardrail-settings-card";
import { PrivacySettingsCard } from "@/components/settings/privacy-settings-card";
import {
  RuntimeSettingsCard,
  StartupSettingsCard,
} from "@/components/settings/runtime-settings-card";
import { WebEndpointsCard } from "@/components/settings/web-endpoints-card";
import {
  SettingsFormBar,
  SettingsLoadError,
  SettingsLoading,
  SettingsPageShell,
} from "@/components/settings/settings-page-shell";
import { useSettingsDraft } from "@/components/settings/use-settings-draft";

export default function RuntimeSettingsPage(): React.ReactNode {
  const settings = useSettingsDraft();

  return (
    <SettingsPageShell titleKey="settings.page.runtime.title" subtitleKey="settings.page.runtime.subtitle">
      <SettingsFormBar
        loading={settings.loading}
        dirty={settings.dirty}
        saving={settings.saving}
        saveStatus={settings.saveStatus}
        onDiscard={settings.discard}
        onSave={settings.save}
      />

      {settings.loadError ? (
        <SettingsLoadError message={settings.loadError} onRetry={settings.reload} />
      ) : null}

      {settings.loading ? (
        <SettingsLoading />
      ) : settings.snapshot && settings.draft ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <RuntimeSettingsCard draft={settings.draft} onChange={settings.updateDraft} />
            <GuardrailSettingsCard
              draft={settings.draft}
              errors={settings.fieldErrors}
              onChange={settings.updateDraft}
            />
          </div>
          <div className="space-y-6">
            <WebEndpointsCard
              draft={settings.draft}
              errors={settings.fieldErrors}
              onChange={settings.updateDraft}
            />
            <PrivacySettingsCard snapshot={settings.snapshot} />
            <StartupSettingsCard snapshot={settings.snapshot} />
          </div>
        </div>
      ) : null}
    </SettingsPageShell>
  );
}
