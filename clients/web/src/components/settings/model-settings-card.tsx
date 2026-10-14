"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAgent } from "@/lib/agents";
import { useI18n } from "@/lib/i18n-context";
import { MODEL_ROLE_IDS, type SettingsSnapshot } from "@/lib/system-settings";
import {
  testModelRegistration,
  type FieldErrors,
  type SettingsDraft,
} from "@/lib/settings-form";
import { EffectBadge } from "./settings-effect-badge";
import { FieldError } from "./field-error";

export interface ModelSettingsCardProps {
  snapshot: SettingsSnapshot;
  draft: SettingsDraft;
  errors: FieldErrors;
  onChange: (patch: Partial<SettingsDraft>) => void;
}

export function ModelSettingsCard({ snapshot, draft, errors, onChange }: ModelSettingsCardProps) {
  const { t } = useI18n();
  const [pendingRole, setPendingRole] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const availableRoles = MODEL_ROLE_IDS.filter((role) => !(role in draft.modelOverrides));

  const runTest = async () => {
    const model = draft.globalModelOverride.trim();
    if (!model) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testModelRegistration(model);
      const headline = result.ok
        ? t("settings.model.test.ok")
        : t("settings.model.test.notRegistered");
      setTestResult({ ok: result.ok, message: `${headline}${result.detail ? ` — ${result.detail}` : ""}` });
    } catch (error) {
      setTestResult({
        ok: false,
        message: `${t("settings.error.upstream")}${
          error instanceof Error && error.message ? ` — ${error.message}` : ""
        }`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.model.title")}</span>
          <EffectBadge effect="nextSession" />
        </CardTitle>
        <CardDescription>{t("settings.model.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-global-model">{t("settings.model.global")}</Label>
            <EffectBadge effect="nextSession" />
          </div>
          <div className="flex items-start gap-2">
            <Input
              id="settings-global-model"
              value={draft.globalModelOverride}
              placeholder={t("settings.model.global.placeholder")}
              aria-invalid={Boolean(errors.globalModelOverride)}
              onChange={(event) => onChange({ globalModelOverride: event.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!draft.globalModelOverride.trim() || testing}
              onClick={() => void runTest()}
            >
              {testing ? <Loader2 className="animate-spin" /> : null}
              {testing ? t("settings.model.test.testing") : t("settings.model.test.button")}
            </Button>
          </div>
          <FieldError message={errors.globalModelOverride} />
          <p className="text-xs text-muted-foreground">{t("settings.model.global.help")}</p>
          {testResult ? (
            <Alert variant={testResult.ok ? "default" : "destructive"}>
              <AlertDescription>{testResult.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="space-y-2 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("settings.model.overrides")}</Label>
            <EffectBadge effect="nextSession" />
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.model.overrides.help")}</p>

          {Object.entries(draft.modelOverrides).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("settings.model.overrides.empty")}</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(draft.modelOverrides).map(([role, model]) => (
                <div key={role} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-sm">{getAgent(role)?.name ?? role}</span>
                  <Input
                    value={model}
                    placeholder={t("settings.model.global.placeholder")}
                    onChange={(event) =>
                      onChange({ modelOverrides: { ...draft.modelOverrides, [role]: event.target.value } })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("settings.model.overrides.remove", {
                      agent: getAgent(role)?.name ?? role,
                    })}
                    onClick={() => {
                      const next = { ...draft.modelOverrides };
                      delete next[role];
                      onChange({ modelOverrides: next });
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <FieldError message={errors.modelOverrides} />

          <div className="flex items-center gap-2">
            <Select value={pendingRole} onValueChange={(value) => setPendingRole(value ?? "")}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder={t("settings.model.overrides.role")} />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {getAgent(role)?.name ?? role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!pendingRole}
              onClick={() => {
                if (!pendingRole) return;
                onChange({ modelOverrides: { ...draft.modelOverrides, [pendingRole]: "" } });
                setPendingRole("");
              }}
            >
              <Plus />
              {t("settings.model.overrides.add")}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-proxy-key">{t("settings.model.proxyKey")}</Label>
            <EffectBadge effect="probe" />
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="settings-proxy-key"
              type="password"
              autoComplete="off"
              value={draft.llmProxyApiKey}
              placeholder={t("settings.model.proxyKey.placeholder")}
              disabled={draft.clearProxyKey}
              onChange={(event) =>
                onChange({ llmProxyApiKey: event.target.value, clearProxyKey: false })
              }
            />
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
              {snapshot.llmProxyApiKeySet
                ? t("settings.model.proxyKey.set")
                : t("settings.model.proxyKey.unset")}
            </Badge>
            {snapshot.llmProxyApiKeySet ? (
              <Button
                type="button"
                variant={draft.clearProxyKey ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onChange({ clearProxyKey: !draft.clearProxyKey, llmProxyApiKey: "" })}
              >
                {t("settings.model.proxyKey.clear")}
              </Button>
            ) : null}
          </div>
          {draft.clearProxyKey ? (
            <p className="text-xs text-amber-400">{t("settings.model.proxyKey.pendingClear")}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("settings.model.proxyKey.help")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
