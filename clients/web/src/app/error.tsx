"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n-context";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error("[Decepticon] Unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8">
      <div className="rounded-xl bg-red-500/10 p-6 ring-1 ring-red-500/20">
        <h2 className="text-lg font-semibold text-red-300">{t("error.title")}</h2>
        <p className="mt-2 max-w-md text-sm text-red-400/70">
          {error.message || t("error.fallback")}
        </p>
        {error.digest && (
          <p className="mt-1 font-mono text-xs text-zinc-500">{t("error.digest")}: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="mt-4 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/30"
        >
          {t("error.retry")}
        </button>
      </div>
    </div>
  );
}
