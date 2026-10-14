"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { REASONING_EFFORTS, SETTINGS_LIMITS, type ReasoningEffort } from "@/lib/system-settings";
import type { FieldErrors, SettingsDraft } from "@/lib/settings-form";
import { EffectBadge } from "./settings-effect-badge";
import { FieldError } from "./field-error";

const REASONING_KEYS: Record<ReasoningEffort, TranslationKey> = {
  none: "settings.models.reasoning.none",
  low: "settings.models.reasoning.low",
  medium: "settings.models.reasoning.medium",
  high: "settings.models.reasoning.high",
  xhigh: "settings.models.reasoning.xhigh",
  max: "settings.models.reasoning.max",
};

export interface ModelAdvancedCardProps {
  draft: SettingsDraft;
  errors: FieldErrors;
  onChange: (patch: Partial<SettingsDraft>) => void;
  /** NAMES of the extra provider headers the agent process resolved from its env. */
  extraHeaderNames: string[];
}

/**
 * Request-level knobs for the agent's model calls: reasoning effort, an output
 * ceiling and streaming.
 *
 * Every editable value here reaches the agent through the run-input channel
 * (`DECEPTICON_RUN_*` → CLI → LangGraph run input), which is resolved when the next
 * terminal session spawns — hence the "next terminal session" badge and not an
 * "immediate" one.
 *
 * The reasoning select renders `REASONING_EFFORTS` (all six tiers, ascending) and
 * the chosen tier travels verbatim: nothing here downgrades `xhigh`/`max` to a
 * tier the model knows, so a provider that rejects one surfaces its own error.
 *
 * Extra provider headers are deliberately NOT editable: their values are
 * credentials-adjacent, the run input round-trips through the LangGraph checkpoint,
 * and the agent core resolves them from `DECEPTICON_LLM_EXTRA_HEADERS` in its own
 * environment at model construction. The card only REPORTS the header NAMES.
 */
export function ModelAdvancedCard({
  draft,
  errors,
  onChange,
  extraHeaderNames,
}: ModelAdvancedCardProps) {
  const { t } = useI18n();
  const output = SETTINGS_LIMITS.llmMaxOutputTokens;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.models.advanced.title")}</span>
          <EffectBadge effect="nextSession" />
        </CardTitle>
        <CardDescription>{t("settings.models.advanced.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-advanced-reasoning">{t("settings.models.reasoning")}</Label>
            <EffectBadge effect="nextSession" />
          </div>
          <Select
            value={draft.reasoningEffort}
            onValueChange={(value) =>
              onChange({ reasoningEffort: (value ?? "none") as ReasoningEffort })
            }
          >
            <SelectTrigger id="settings-advanced-reasoning" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_EFFORTS.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {t(REASONING_KEYS[effort])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.models.reasoning.help")}</p>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-advanced-max-output">{t("settings.models.maxOutput")}</Label>
            <EffectBadge effect="nextSession" />
          </div>
          <Input
            id="settings-advanced-max-output"
            inputMode="numeric"
            value={draft.llmMaxOutputTokens}
            aria-invalid={Boolean(errors.llmMaxOutputTokens)}
            onChange={(event) => onChange({ llmMaxOutputTokens: event.target.value })}
          />
          <FieldError message={errors.llmMaxOutputTokens} />
          <p className="text-xs text-muted-foreground">
            {t("settings.models.maxOutput.help", { min: output.min, max: output.max })}
          </p>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="settings-advanced-streaming"
              className="flex cursor-pointer items-center gap-2 text-sm font-medium"
            >
              <input
                id="settings-advanced-streaming"
                type="checkbox"
                className="h-4 w-4"
                checked={!draft.llmDisableStreaming}
                onChange={(event) => onChange({ llmDisableStreaming: !event.target.checked })}
              />
              <span>{t("settings.models.streaming")}</span>
            </label>
            <EffectBadge effect="nextSession" />
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.models.streaming.help")}</p>
        </div>

        <div className="space-y-2 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("settings.models.headers")}</Label>
            <EffectBadge effect="readOnly" />
          </div>
          <p className="font-mono text-xs">
            {extraHeaderNames.length > 0
              ? extraHeaderNames.join(", ")
              : t("settings.models.headers.empty")}
          </p>
          <p className="text-xs text-muted-foreground">{t("settings.models.headers.help")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
