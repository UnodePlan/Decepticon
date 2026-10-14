"use client";

import { useI18n } from "@/lib/i18n-context";

export default function DashboardLoading() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-purple-500" />
        <p className="text-sm text-zinc-500">{t("loading.dashboard")}</p>
      </div>
    </div>
  );
}
