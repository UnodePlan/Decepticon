"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Globe, Server, Loader2 } from "lucide-react";
import { isValidEngagementSlug } from "@/lib/engagement-slug";
import { useI18n } from "@/lib/i18n-context";

export default function NewEngagementPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [targetType, setTargetType] = useState("web_url");
  const [name, setName] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [initialMode, setInitialMode] = useState<"plan" | "red" | "blue">("red");
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [authorizationReference, setAuthorizationReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = isValidEngagementSlug(name);
  const nameError =
    name.length > 0 && !nameValid
      ? t("newEngagement.error.nameFormat")
      : null;

  async function handleSubmit() {
    if (!nameValid || !targetValue.trim() || !authorizationConfirmed || !authorizationReference.trim()) {
      setError(t("newEngagement.error.missingFields"));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/engagements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, targetType, targetValue, authorizationConfirmed, authorizationReference, initialMode }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("newEngagement.error.create"));
      }

      const engagement = await res.json();
      router.push(`/engagements/${engagement.id}/live?mode=${initialMode}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("newEngagement.error.unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("newEngagement.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("newEngagement.subtitle")}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("newEngagement.details")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("newEngagement.name")}</Label>
            <Input
              id="name"
              placeholder={t("newEngagement.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
            />
            {nameError ? (
              <p className="text-xs text-destructive">{nameError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("newEngagement.nameHint")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("newEngagement.startingMode")}</Label>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("newEngagement.startingMode")}>
              {(["plan", "red", "blue"] as const).map((mode) => (
                <Button key={mode} type="button" variant={initialMode === mode ? "default" : "outline"} onClick={() => setInitialMode(mode)} aria-pressed={initialMode === mode}>
                  {mode === "plan" ? t("nav.plan") : mode === "red" ? "Red" : "Blue"}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("newEngagement.modeHint")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("newEngagement.targetConfig")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs
            value={targetType}
            onValueChange={(v) => {
              setTargetType(v);
              setTargetValue("");
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="web_url" className="flex-1 gap-2">
                <Globe className="h-4 w-4" />
                {t("newEngagement.webUrl")}
              </TabsTrigger>
              <TabsTrigger value="ip_range" className="flex-1 gap-2">
                <Server className="h-4 w-4" />
                {t("newEngagement.ipRange")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="web_url" className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="url">{t("newEngagement.targetUrl")}</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("newEngagement.targetUrlHint")}
                </p>
              </div>
            </TabsContent>

            <TabsContent value="ip_range" className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ip">{t("newEngagement.ipRange")}</Label>
                <Input
                  id="ip"
                  placeholder="192.168.1.0/24"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("newEngagement.ipHint")}
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("newEngagement.authorization")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 space-y-2">
            <Label htmlFor="authorization-reference">{t("newEngagement.authorizationReference")}</Label>
            <Input id="authorization-reference" value={authorizationReference} onChange={(event) => setAuthorizationReference(event.target.value)} placeholder={t("newEngagement.authorizationPlaceholder")} />
          </div>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={authorizationConfirmed}
              onChange={(event) => setAuthorizationConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              {t("newEngagement.authorizationStatement")}
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          {t("newEngagement.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={submitting || !nameValid || !authorizationConfirmed || !authorizationReference.trim()}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("newEngagement.create")}
        </Button>
      </div>
    </div>
  );
}
