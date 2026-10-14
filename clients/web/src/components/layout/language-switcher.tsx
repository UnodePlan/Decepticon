"use client";

import { Check, Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n-context";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";

/** Compact zh/en switch for the header and the login card. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("header.language")}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Languages className="h-4 w-4" />
        <span className="text-xs font-medium">{LOCALE_LABELS[locale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {LOCALES.map((candidate) => (
          <DropdownMenuItem
            key={candidate}
            onClick={() => setLocale(candidate)}
            className="justify-between"
          >
            <span>{LOCALE_LABELS[candidate]}</span>
            {candidate === locale && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
