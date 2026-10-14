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
import type { FieldErrors, SettingsDraft } from "@/lib/settings-form";
import { EffectBadge } from "./settings-effect-badge";
import { FieldError } from "./field-error";

export interface WebEndpointsCardProps {
  draft: SettingsDraft;
  errors: FieldErrors;
  onChange: (patch: Partial<SettingsDraft>) => void;
}

/**
 * Browser-facing endpoints. Unlike the read-only deployment card, these are the
 * URLs the console itself dials, so they apply to the next page interaction.
 */
export function WebEndpointsCard({ draft, errors, onChange }: WebEndpointsCardProps) {
  const { t } = useI18n();

  const fields = [
    {
      id: "settings-langgraph-url",
      label: t("settings.runtime.langGraphUrl"),
      value: draft.langGraphBrowserUrl,
      error: errors.langGraphBrowserUrl,
      onChange: (value: string) => onChange({ langGraphBrowserUrl: value }),
    },
    {
      id: "settings-terminal-url",
      label: t("settings.runtime.terminalUrl"),
      value: draft.terminalBrowserUrl,
      error: errors.terminalBrowserUrl,
      onChange: (value: string) => onChange({ terminalBrowserUrl: value }),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.endpoints.title")}</span>
          <EffectBadge effect="nextRequest" />
        </CardTitle>
        <CardDescription>{t("settings.endpoints.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => (
          <div key={field.id} className="space-y-1.5">
            <Label htmlFor={field.id}>{field.label}</Label>
            <Input
              id={field.id}
              value={field.value}
              aria-invalid={Boolean(field.error)}
              onChange={(event) => field.onChange(event.target.value)}
            />
            <FieldError message={field.error} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
