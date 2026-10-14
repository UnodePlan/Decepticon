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
import { useI18n } from "@/lib/i18n-context";
import { SETTINGS_LIMITS } from "@/lib/system-settings";
import type { FieldErrors, SettingsDraft } from "@/lib/settings-form";
import { EffectBadge } from "./settings-effect-badge";
import { FieldError } from "./field-error";

export interface GuardrailSettingsCardProps {
  draft: SettingsDraft;
  errors: FieldErrors;
  onChange: (patch: Partial<SettingsDraft>) => void;
}

/**
 * Spend caps and the human-approval gate.
 *
 * All four travel as `DECEPTICON_RUN_*` values into the run input of the next
 * terminal session (`budget_*` / `hitl_enabled` on `ModelOverridesState`), where
 * the budget middleware and the HITL slot read them per run — a run that is
 * already in flight keeps the posture it started with.
 *
 * The caps are one-way by design: a run input may only TIGHTEN the deployment's
 * cap, so an empty (or `0`) field sends nothing and the deployment value governs.
 * The hints say so rather than implying the field can lift a limit.
 */
export function GuardrailSettingsCard({ draft, errors, onChange }: GuardrailSettingsCardProps) {
  const { t } = useI18n();
  const budget = SETTINGS_LIMITS.budgetUsd;
  const softWarn = SETTINGS_LIMITS.budgetSoftWarnAtPct;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.guardrails.title")}</span>
          <EffectBadge effect="nextSession" />
        </CardTitle>
        <CardDescription>{t("settings.guardrails.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-budget-engagement">{t("settings.guardrails.budgetEngagement")}</Label>
            <Input
              id="settings-budget-engagement"
              inputMode="decimal"
              value={draft.budgetEngagementUsd}
              aria-invalid={Boolean(errors.budgetEngagementUsd)}
              onChange={(event) => onChange({ budgetEngagementUsd: event.target.value })}
            />
            <FieldError message={errors.budgetEngagementUsd} />
            <p className="text-xs text-muted-foreground">
              {t("settings.guardrails.budgetEngagement.help")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-budget-per-agent">{t("settings.guardrails.budgetPerAgent")}</Label>
            <Input
              id="settings-budget-per-agent"
              inputMode="decimal"
              value={draft.budgetPerAgentUsd}
              aria-invalid={Boolean(errors.budgetPerAgentUsd)}
              onChange={(event) => onChange({ budgetPerAgentUsd: event.target.value })}
            />
            <FieldError message={errors.budgetPerAgentUsd} />
            <p className="text-xs text-muted-foreground">{t("settings.guardrails.budgetPerAgent.help")}</p>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <Label htmlFor="settings-budget-soft-warn">{t("settings.guardrails.softWarn")}</Label>
          <Input
            id="settings-budget-soft-warn"
            inputMode="numeric"
            value={draft.budgetSoftWarnAtPct}
            aria-invalid={Boolean(errors.budgetSoftWarnAtPct)}
            onChange={(event) => onChange({ budgetSoftWarnAtPct: event.target.value })}
          />
          <FieldError message={errors.budgetSoftWarnAtPct} />
          <p className="text-xs text-muted-foreground">
            {t("settings.guardrails.softWarn.help", { min: softWarn.min, max: softWarn.max })}
          </p>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="settings-hitl-enabled"
              className="flex cursor-pointer items-center gap-2 text-sm font-medium"
            >
              <input
                id="settings-hitl-enabled"
                type="checkbox"
                className="h-4 w-4"
                checked={draft.hitlEnabled}
                onChange={(event) => onChange({ hitlEnabled: event.target.checked })}
              />
              <span>{t("settings.guardrails.hitl")}</span>
            </label>
            <EffectBadge effect="nextSession" />
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.guardrails.hitl.help")}</p>
          <p className="text-xs text-muted-foreground">
            {t("settings.guardrails.budgetRange", { min: budget.min, max: budget.max })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
