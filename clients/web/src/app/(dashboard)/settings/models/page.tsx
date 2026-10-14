"use client";

/**
 * Model settings screen: the custom LLM channel plus the model overrides that
 * new terminal sessions receive.
 *
 * Split out of the former single settings page so the rail can link straight to
 * it; the content is exactly the model-related cards, and nothing else loads.
 */

import { useCallback, useEffect, useState } from "react";
import { LlmChannelCard } from "@/components/settings/llm-channel-card";
import { ModelAdvancedCard } from "@/components/settings/model-advanced-card";
import { ModelSettingsCard } from "@/components/settings/model-settings-card";
import {
  SettingsFormBar,
  SettingsLoadError,
  SettingsLoading,
  SettingsPageShell,
} from "@/components/settings/settings-page-shell";
import { useSettingsDraft } from "@/components/settings/use-settings-draft";
import { useI18n } from "@/lib/i18n-context";
import {
  channelErrorKey,
  loadChannel,
  type LlmChannelSnapshot,
} from "@/lib/llm-channel-form";

export default function ModelSettingsPage(): React.ReactNode {
  const { t } = useI18n();
  const settings = useSettingsDraft();
  // Stable callback from the hook: the card is re-rendered by the page's own
  // state anyway, so nothing here should depend on the whole hook object.
  const { adoptGlobalModelOverride } = settings;

  // Custom LLM channel: independent of the settings snapshot — its own GET/PUT.
  // `null` + no error is what the card reads as "first load still in flight".
  const [channel, setChannel] = useState<LlmChannelSnapshot | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  const loadLlmChannel = useCallback(async () => {
    setChannelError(null);
    const outcome = await loadChannel();
    if (!outcome.ok) {
      setChannel(null);
      setChannelError(t(channelErrorKey(outcome.status)));
      return;
    }
    setChannel(outcome.snapshot);
  }, [t]);

  useEffect(() => {
    void loadLlmChannel();
  }, [loadLlmChannel]);

  /**
   * A channel save/removal registered a proxy alias as the global model
   * override: adopt it so the editable form cannot overwrite it with a stale
   * value on the next save.
   */
  const adoptChannel = useCallback(
    (next: LlmChannelSnapshot, globalModelOverride: string) => {
      setChannel(next);
      setChannelError(null);
      adoptGlobalModelOverride(globalModelOverride);
    },
    [adoptGlobalModelOverride],
  );

  const channelCard = (
    <LlmChannelCard
      snapshot={channel}
      loadError={channelError}
      onReload={() => void loadLlmChannel()}
      onSaved={adoptChannel}
    />
  );

  return (
    <SettingsPageShell titleKey="settings.page.models.title" subtitleKey="settings.page.models.subtitle">
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
          {channelCard}
          <div className="space-y-6">
            <ModelSettingsCard
              snapshot={settings.snapshot}
              draft={settings.draft}
              errors={settings.fieldErrors}
              onChange={settings.updateDraft}
            />
            <ModelAdvancedCard
              draft={settings.draft}
              errors={settings.fieldErrors}
              onChange={settings.updateDraft}
              extraHeaderNames={settings.snapshot.llmExtraHeaderNames}
            />
          </div>
        </div>
      ) : (
        // The settings snapshot failed to load, but the channel has its own
        // endpoints: keep the card usable instead of hiding it behind that error.
        channelCard
      )}
    </SettingsPageShell>
  );
}
