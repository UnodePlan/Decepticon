"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";

type FailureKind = "invalid" | "unavailable" | "network" | "rateLimited";

const FAILURE_KEY: Record<FailureKind, TranslationKey> = {
  invalid: "login.error.invalid",
  unavailable: "login.error.unavailable",
  network: "login.error.network",
  rateLimited: "login.error.rateLimited",
};

function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Only same-origin paths are honoured — an attacker-supplied `next` must
  // never be able to bounce the operator off-site after a successful sign-in.
  const requested = searchParams.get("next");
  const destination = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        router.replace(destination);
        router.refresh();
        return;
      }
      if (response.status === 503) setFailure("unavailable");
      else if (response.status === 429) setFailure("rateLimited");
      else setFailure("invalid");
    } catch {
      setFailure("network");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="username">{t("login.username")}</Label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("login.password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{t(FAILURE_KEY[failure])}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={submitting || !username || !password}>
        {submitting && <Loader2 className="animate-spin" />}
        {submitting ? t("login.submitting") : t("login.submit")}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">Decepticon</span>
          </div>
          <LanguageSwitcher />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("login.title")}</CardTitle>
            <CardDescription>{t("login.subtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={null}>
              <LoginForm />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
