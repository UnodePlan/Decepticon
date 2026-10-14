"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { useI18n } from "@/lib/i18n-context";

export function Header() {
  const { t } = useI18n();
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // The session cookie is HttpOnly (invisible to JS), so "was there a session?"
  // is remembered from the last successful probe instead of read from the DOM.
  const observedSession = useRef(false);

  useEffect(() => {
    let active = true;

    async function check() {
      try {
        const response = await fetch("/api/auth/login", { cache: "no-store" });
        if (!active) return;
        if (response.ok) {
          const payload = (await response.json()) as { username?: string | null };
          if (payload.username) {
            observedSession.current = true;
            setUsername(payload.username);
          }
          return;
        }
        // A session that existed when the tab opened and is gone now (expired)
        // sends the operator back to the login screen.
        if (response.status === 401 && observedSession.current) router.replace("/login");
      } catch {
        // Offline or restarting — keep the shell and retry on the next tick.
      }
    }

    void check();
    const timer = setInterval(check, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [router]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Navigate regardless of the response: the cookie is cleared server-side.
      router.replace("/login");
      router.refresh();
      setSigningOut(false);
    }
  }, [router]);

  return (
    <header className="flex h-14 items-center justify-between border-b border-border/50 bg-background/80 px-6 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t("header.platform")}</h2>
        <Separator orientation="vertical" className="h-4" />
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
          {t("header.online")}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <LanguageSwitcher />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label={t("header.notifications")}
        >
          <Bell className="h-4 w-4" />
        </Button>
        {username === null ? (
          <span className="text-xs text-muted-foreground">{t("header.notAuthenticated")}</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            disabled={signingOut}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <LogOut />
            <span className="text-xs font-medium">
              {signingOut ? t("header.signingOut") : t("header.signOut")}
            </span>
          </Button>
        )}
      </div>
    </header>
  );
}
