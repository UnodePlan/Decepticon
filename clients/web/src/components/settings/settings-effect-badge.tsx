"use client";

/**
 * The "when does this actually take effect" badge, shared by every settings card.
 *
 * The kinds are UI wording, not storage semantics: `@/lib/system-settings`
 * declares a single `next-session` boundary that covers both the agent-run knobs
 * (read when a NEW terminal session spawns) and the page-request values (read on
 * the next page load). The two read very differently to an operator, so the card
 * picks the wording that matches the field it labels instead of paraphrasing the
 * contract — and no card may claim `immediate` for either.
 */

import { Badge } from "@/components/ui/badge";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

export type EffectBadgeKind =
  /** Agent-run/LLM knobs: consumed when the next terminal session starts. */
  | "nextSession"
  /** Language default and browser endpoints: consumed by the next page request. */
  | "nextRequest"
  /** Deployment/startup facts: only a restart picks them up. */
  | "restart"
  /** Startup-scoped: reported by the API, rejected by a PUT. */
  | "readOnly"
  /** Used only by the dashboard's own model probe. */
  | "probe";

const EFFECT_LABELS: Record<EffectBadgeKind, TranslationKey> = {
  nextSession: "settings.effect.nextSession",
  nextRequest: "settings.effect.nextRequest",
  restart: "settings.effect.restart",
  readOnly: "settings.effect.readOnly",
  probe: "settings.effect.probe",
};

export function EffectBadge({ effect }: { effect: EffectBadgeKind }) {
  const { t } = useI18n();
  return (
    <Badge variant="outline" className="text-[10px] font-normal">
      {t(EFFECT_LABELS[effect])}
    </Badge>
  );
}
