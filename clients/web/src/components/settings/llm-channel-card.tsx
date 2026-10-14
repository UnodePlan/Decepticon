"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, PlugZap, Plus, RefreshCw, Trash2, X } from "lucide-react";
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
import { useI18n } from "@/lib/i18n-context";
import { LLM_CHANNEL_LIMITS, protocolSupportsModelList } from "@/lib/llm-channel";
import {
  blankHeaderRow,
  channelDraftFromSnapshot,
  channelErrorKey,
  channelModelOptions,
  channelProtocolOptions,
  EMPTY_CHANNEL,
  fetchChannelModels,
  localizeChannelFields,
  removeChannel,
  sameChannelBase,
  saveChannel,
  testChannel,
  validateChannelDraft,
  validateChannelEndpoint,
  type ChannelDraft,
  type ChannelFieldErrors,
  type LlmChannelSnapshot,
} from "@/lib/llm-channel-form";
import { FieldError } from "./field-error";

export interface LlmChannelCardProps {
  /** Server state; null while the first load is in flight or after it failed. */
  snapshot: LlmChannelSnapshot | null;
  /** Localized sentence shown when the channel could not be loaded. */
  loadError: string | null;
  onReload: () => void;
  /**
   * A save/removal already reached the server: adopt the stored channel and the
   * effective global model override (the proxy alias, or whatever survived a
   * removal) so a stale global-model draft cannot overwrite it later.
   */
  onSaved: (snapshot: LlmChannelSnapshot, globalModelOverride: string) => void;
}

type ChannelStatus = { kind: "ok" | "error"; message: string } | null;

const CONTEXT = LLM_CHANNEL_LIMITS.contextWindowTokens;
const OUTPUT = LLM_CHANNEL_LIMITS.maxOutputTokens;

/**
 * Custom LLM channel: an endpoint the operator adds from the console. The flow is
 * linear — base URL and protocol, then the models the endpoint advertises (or a
 * typed id when the protocol has no listing), the token budget the proxy should
 * honour, any headers the endpoint needs, a test, then save — because saving also
 * registers the model with the LLM proxy and rewrites the global model override,
 * so everything the registration carries has to be settled first.
 *
 * Write-only fields: the API key and every header value start blank on every load
 * and are never returned by the server. Leaving a value blank keeps the stored one
 * (same base), which the hints say explicitly.
 */
export function LlmChannelCard({ snapshot, loadError, onReload, onSaved }: LlmChannelCardProps) {
  const { t } = useI18n();
  const baseline = snapshot ?? EMPTY_CHANNEL;

  const [draft, setDraft] = useState<ChannelDraft>(() => channelDraftFromSnapshot(baseline));
  const [models, setModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState(() => !protocolSupportsModelList(baseline.protocol));
  const [errors, setErrors] = useState<ChannelFieldErrors>({});
  const [busy, setBusy] = useState<null | "fetch" | "test" | "save" | "remove">(null);
  const [status, setStatus] = useState<ChannelStatus>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A new server snapshot (initial load, retry, or the response to our own save)
  // is the new baseline: the endpoint may have changed, so the model list and any
  // pending edits belong to the previous channel. The status line is deliberately
  // left alone — clearing it here would erase the "saved" wording the operator
  // asked for, one render after the save that produced it.
  useEffect(() => {
    const next = snapshot ?? EMPTY_CHANNEL;
    setDraft(channelDraftFromSnapshot(next));
    setModels([]);
    // A protocol with no standard listing starts in the manual-id input: a stored
    // Anthropic Messages channel must not present an empty picker with no way to
    // type the model it is already configured with.
    setManualModel(!protocolSupportsModelList(next.protocol));
    setErrors({});
    setNotice(null);
  }, [snapshot]);

  const configured = baseline.apiBase.trim() !== "";
  const baseChanged = configured && !sameChannelBase(baseline.apiBase, draft.apiBase);
  const keyDropped = baseline.apiKeySet && baseChanged && draft.apiKey.trim() === "";
  const listing = protocolSupportsModelList(draft.protocol);
  const dirty =
    draft.apiBase !== baseline.apiBase ||
    draft.model !== baseline.model ||
    draft.protocol !== baseline.protocol ||
    draft.contextWindowTokens !== String(baseline.contextWindowTokens) ||
    draft.maxOutputTokens !== String(baseline.maxOutputTokens) ||
    draft.apiKey !== "" ||
    // A saved header renders as NAME + blank value ("value kept"): that row alone
    // is not an edit, so it must not leave Save permanently enabled.
    draft.extraHeaders.some((row) => {
      const name = row.name.trim();
      const value = row.value.trim();
      if (name === "") return value !== "";
      // Header names are case-insensitive and the server stores them lower-cased,
      // so a re-cased name must still count as "not an edit".
      if (value === "" && baseline.extraHeadersSet.includes(name.toLowerCase())) return false;
      return true;
    });
  const options = channelModelOptions(models, baseline.model, draft.model);
  // Base UI renders the raw selected value in the trigger unless the root is given
  // an `items` map: `SelectItem` children are not read as labels. Deriving both the
  // options and this map from one list is also why they can never disagree. The
  // current value is mapped even when its protocol is not offered (a proxy that
  // dropped `messages` still has to name the stored row in the trigger).
  const protocols = channelProtocolOptions(baseline);
  const protocolLabels: Record<string, string> = {
    [draft.protocol]: t(`settings.channel.protocol.${draft.protocol}` as const),
  };
  for (const protocol of protocols) {
    protocolLabels[protocol] = t(`settings.channel.protocol.${protocol}` as const);
  }

  const update = (patch: Partial<ChannelDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setStatus(null);
    setNotice(null);
  };

  // A different protocol is a different endpoint contract: the listing came from a
  // protocol-specific path, so it must not survive the switch.
  const changeProtocol = (protocol: ChannelDraft["protocol"]) => {
    setModels([]);
    setManualModel(!protocolSupportsModelList(protocol));
    update({ protocol });
  };

  const updateHeader = (index: number, patch: { name?: string; value?: string }) => {
    setDraft((previous) => {
      const rows = previous.extraHeaders.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      );
      // Keep exactly one blank row at the end so there is always somewhere to type.
      if (rows[rows.length - 1].name.trim() !== "") rows.push(blankHeaderRow());
      return { ...previous, extraHeaders: rows };
    });
    setStatus(null);
    setNotice(null);
  };

  const removeHeader = (index: number) => {
    setDraft((previous) => {
      const rows = previous.extraHeaders.filter((_, position) => position !== index);
      return {
        ...previous,
        extraHeaders: rows.length > 0 ? rows : [blankHeaderRow()],
      };
    });
    setStatus(null);
  };

  const runFetchModels = async () => {
    const invalid = validateChannelEndpoint(draft, t);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      return;
    }
    setBusy("fetch");
    setErrors({});
    setNotice(null);
    setStatus(null);
    const outcome = await fetchChannelModels(baseline, draft);
    setBusy(null);

    if (!outcome.ok) {
      setErrors(localizeChannelFields(outcome.fields, t));
      setStatus({ kind: "error", message: t(channelErrorKey(outcome.status)) });
      return;
    }
    setModels(outcome.models);
    setManualModel(outcome.manual);
    if (outcome.manual) {
      setNotice(t("settings.channel.models.manual"));
      return;
    }
    // Keep the current selection when the endpoint still offers it; a single
    // advertised model is the obvious choice, so preselect it.
    const selected = draft.model.trim();
    if (!outcome.models.includes(selected)) {
      update({ model: outcome.models.length === 1 ? outcome.models[0] : "" });
    }
    if (outcome.models.length === 0) setNotice(t("settings.channel.models.empty"));
  };

  const runTest = async () => {
    const invalid = validateChannelDraft(draft, t);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      return;
    }
    setBusy("test");
    setErrors({});
    setStatus(null);
    const outcome = await testChannel(baseline, draft, t);
    setBusy(null);

    // The draft is deliberately kept on failure: a rejected key or a missing route
    // is exactly when the operator needs the values they typed still on screen.
    setStatus(
      outcome.ok
        ? { kind: "ok", message: t("settings.channel.tested") }
        : { kind: "error", message: outcome.detail },
    );
  };

  const runSave = async () => {
    const invalid = validateChannelDraft(draft, t);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      return;
    }
    setBusy("save");
    setErrors({});
    setStatus(null);
    const outcome = await saveChannel(baseline, draft);
    setBusy(null);

    if (!outcome.ok) {
      setErrors(localizeChannelFields(outcome.fields, t));
      setStatus({ kind: "error", message: t(channelErrorKey(outcome.status)) });
      return;
    }
    setStatus({
      kind: "ok",
      message: t("settings.channel.saved", { alias: outcome.globalModelOverride }),
    });
    onSaved(outcome.snapshot, outcome.globalModelOverride);
  };

  const runRemove = async () => {
    setBusy("remove");
    setErrors({});
    setStatus(null);
    const outcome = await removeChannel();
    setBusy(null);

    if (!outcome.ok) {
      setErrors(localizeChannelFields(outcome.fields, t));
      setStatus({ kind: "error", message: t(channelErrorKey(outcome.status)) });
      return;
    }
    setStatus({ kind: "ok", message: t("settings.channel.removed") });
    onSaved(outcome.snapshot, outcome.globalModelOverride);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{t("settings.channel.title")}</span>
          <Badge variant="outline" className="text-[10px] font-normal">
            {t("settings.effect.nextSession")}
          </Badge>
        </CardTitle>
        <CardDescription>{t("settings.channel.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span role="status">
                {t("settings.channel.loadError")} — {loadError}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={onReload}>
                {t("settings.channel.reload")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="settings-channel-base">{t("settings.channel.apiBase")}</Label>
          <Input
            id="settings-channel-base"
            value={draft.apiBase}
            placeholder={t("settings.channel.apiBase.placeholder")}
            aria-invalid={Boolean(errors.apiBase)}
            onChange={(event) => update({ apiBase: event.target.value })}
          />
          <FieldError message={errors.apiBase} />
          <p className="text-xs text-muted-foreground">{t("settings.channel.apiBase.help")}</p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-channel-protocol">{t("settings.channel.protocol")}</Label>
            <Select
              value={draft.protocol}
              items={protocolLabels}
              onValueChange={(value) => changeProtocol(value as ChannelDraft["protocol"])}
            >
              <SelectTrigger id="settings-channel-protocol" className="w-full" aria-invalid={Boolean(errors.protocol)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {protocols.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocolLabels[protocol]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.protocol} />
            <p className="text-xs text-muted-foreground">
              {t(`settings.channel.protocol.${draft.protocol}.help` as const)}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-channel-key">{t("settings.channel.apiKey")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="settings-channel-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={t("settings.channel.apiKey.placeholder")}
                aria-invalid={Boolean(errors.apiKey)}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
              <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                {baseline.apiKeySet ? t("settings.channel.key.saved") : t("settings.channel.key.none")}
              </Badge>
            </div>
            <FieldError message={errors.apiKey} />
            {keyDropped ? (
              <p className="text-xs text-amber-400">{t("settings.channel.key.baseChanged")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("settings.channel.apiKey.help")}</p>
            )}
          </div>
        </div>

        <div className="space-y-1.5 border-t border-border/50 pt-4">
          <Label htmlFor="settings-channel-model">{t("settings.channel.models")}</Label>
          <div className="flex items-start gap-2">
            {manualModel ? (
              <Input
                id="settings-channel-model"
                value={draft.model}
                placeholder={t("settings.channel.models.manualPlaceholder")}
                aria-invalid={Boolean(errors.model)}
                onChange={(event) => update({ model: event.target.value })}
              />
            ) : (
              <Select value={draft.model} onValueChange={(value) => update({ model: value ?? "" })}>
                <SelectTrigger id="settings-channel-model" className="w-full" aria-invalid={Boolean(errors.model)}>
                  <SelectValue placeholder={t("settings.channel.models.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {listing ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || draft.apiBase.trim() === ""}
                onClick={() => void runFetchModels()}
              >
                {busy === "fetch" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {busy === "fetch" ? t("settings.channel.fetching") : t("settings.channel.fetch")}
              </Button>
            ) : null}
          </div>
          <FieldError message={errors.model} />
          {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
          {models.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.channel.models.count", { count: models.length })}
            </p>
          ) : null}
        </div>

        <div className="grid gap-5 border-t border-border/50 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-channel-context">{t("settings.channel.contextWindow")}</Label>
            <Input
              id="settings-channel-context"
              inputMode="numeric"
              value={draft.contextWindowTokens}
              aria-invalid={Boolean(errors.contextWindowTokens)}
              onChange={(event) => update({ contextWindowTokens: event.target.value })}
            />
            <FieldError message={errors.contextWindowTokens} />
            <p className="text-xs text-muted-foreground">
              {t("settings.channel.contextWindow.help", { min: CONTEXT.min, max: CONTEXT.max })}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-channel-output">{t("settings.channel.maxOutput")}</Label>
            <Input
              id="settings-channel-output"
              inputMode="numeric"
              value={draft.maxOutputTokens}
              aria-invalid={Boolean(errors.maxOutputTokens)}
              onChange={(event) => update({ maxOutputTokens: event.target.value })}
            />
            <FieldError message={errors.maxOutputTokens} />
            <p className="text-xs text-muted-foreground">
              {t("settings.channel.maxOutput.help", { min: OUTPUT.min, max: OUTPUT.max })}
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-border/50 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("settings.channel.headers")}</Label>
            <Badge variant="outline" className="text-[10px] font-normal">
              {baseline.extraHeadersSet.length > 0
                ? t("settings.channel.headers.set", { count: baseline.extraHeadersSet.length })
                : t("settings.channel.headers.none")}
            </Badge>
          </div>
          {baseline.extraHeadersSet.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.channel.headers.kept", { names: baseline.extraHeadersSet.join(", ") })}
            </p>
          ) : null}
          <div className="space-y-2">
            {draft.extraHeaders.map((row, index) => (
              <div key={row.id} className="flex items-center gap-2">
                <Input
                  value={row.name}
                  placeholder={t("settings.channel.headers.name")}
                  aria-label={t("settings.channel.headers.name")}
                  aria-invalid={Boolean(errors.extraHeaders)}
                  onChange={(event) => updateHeader(index, { name: event.target.value })}
                />
                <Input
                  type="password"
                  autoComplete="off"
                  value={row.value}
                  placeholder={t("settings.channel.headers.value")}
                  aria-label={t("settings.channel.headers.value")}
                  aria-invalid={Boolean(errors.extraHeaders)}
                  onChange={(event) => updateHeader(index, { value: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("settings.channel.headers.remove")}
                  disabled={row.name.trim() === "" && row.value.trim() === ""}
                  onClick={() => removeHeader(index)}
                >
                  {row.name.trim() === "" && row.value.trim() === "" ? <Plus /> : <X />}
                </Button>
              </div>
            ))}
          </div>
          <FieldError message={errors.extraHeaders} />
          <p className="text-xs text-muted-foreground">{t("settings.channel.headers.help")}</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-4">
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void runTest()}>
            {busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {busy === "test" ? t("settings.channel.testing") : t("settings.channel.test")}
          </Button>
          {configured ? (
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void runRemove()}>
              {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {busy === "remove" ? t("settings.channel.removing") : t("settings.channel.remove")}
            </Button>
          ) : null}
          <Button type="button" disabled={busy !== null || !dirty} onClick={() => void runSave()}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : null}
            {busy === "save" ? t("settings.channel.saving") : t("settings.channel.save")}
          </Button>
        </div>

        {status ? (
          <Alert variant={status.kind === "error" ? "destructive" : "default"}>
            <AlertDescription className="flex items-start gap-2">
              {status.kind === "error" ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : null}
              <span role="status">{status.message}</span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
