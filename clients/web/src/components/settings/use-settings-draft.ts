"use client";

/**
 * Shared editing state for every settings screen.
 *
 * The split routes each own a slice of the old single page, but they all edit
 * the same `SettingsSnapshot` through the same partial-patch contract, so the
 * load/validate/save cycle lives here instead of being copy-pasted per page.
 * A page that mounts this hook issues exactly one `GET /api/settings`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import type { SettingsSnapshot } from "@/lib/system-settings";
import {
  buildPatch,
  draftFromSnapshot,
  isDirty,
  parseSettingsSnapshot,
  saveSettingsPatch,
  validateDraft,
  type FieldErrors,
  type SettingsDraft,
} from "@/lib/settings-form";

export type SaveStatus = { kind: "saved" | "error"; message: string } | null;

export interface SettingsDraftState {
  /** Server baseline; null while loading or after a failed load. */
  snapshot: SettingsSnapshot | null;
  /** Editable copy of `snapshot`; null exactly when `snapshot` is null. */
  draft: SettingsDraft | null;
  /** Field-keyed messages, already localized. */
  fieldErrors: FieldErrors;
  loading: boolean;
  /** Localized sentence shown when the snapshot could not be loaded. */
  loadError: string | null;
  saving: boolean;
  saveStatus: SaveStatus;
  /** True when the draft differs from the snapshot in at least one key. */
  dirty: boolean;
  reload: () => void;
  updateDraft: (patch: Partial<SettingsDraft>) => void;
  discard: () => void;
  save: () => void;
  /**
   * Adopt a global model override written by another flow (the custom LLM
   * channel registers a proxy alias). Both the baseline and the draft move in
   * lockstep so the save button stays disabled and no stale global model can be
   * re-PUT over the alias.
   */
  adoptGlobalModelOverride: (globalModelOverride: string) => void;
}

export function useSettingsDraft(): SettingsDraftState {
  const { t } = useI18n();

  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/settings", { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        throw new Error(t(response.status === 401 ? "settings.error.unauthorized" : "settings.error.server"));
      }
      const parsed = parseSettingsSnapshot(await response.json());
      if (!parsed) throw new Error(t("settings.error.server"));
      setSnapshot(parsed);
      setDraft(draftFromSnapshot(parsed));
      setFieldErrors({});
      setSaveStatus(null);
    } catch (error) {
      setSnapshot(null);
      setDraft(null);
      setLoadError(error instanceof Error ? error.message : t("settings.error.server"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateDraft = useCallback((patch: Partial<SettingsDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveStatus(null);
  }, []);

  const discard = useCallback(() => {
    if (!snapshot) return;
    setDraft(draftFromSnapshot(snapshot));
    setFieldErrors({});
    setSaveStatus(null);
  }, [snapshot]);

  const save = useCallback(async () => {
    if (!snapshot || !draft) return;
    const errors = validateDraft(snapshot, draft, t);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSaveStatus({ kind: "error", message: t("settings.saveError") });
      return;
    }

    setSaving(true);
    setSaveStatus(null);
    const outcome = await saveSettingsPatch(buildPatch(snapshot, draft), t);
    setSaving(false);

    if (!outcome.snapshot) {
      setFieldErrors(outcome.fields);
      setSaveStatus({ kind: "error", message: outcome.message });
      return;
    }
    // Atomic replacement: the saved response is the new baseline, and the
    // write-only proxy key field always comes back empty.
    setSnapshot(outcome.snapshot);
    setDraft(draftFromSnapshot(outcome.snapshot));
    setFieldErrors({});
    setSaveStatus({ kind: "saved", message: t("settings.saved") });
  }, [snapshot, draft, t]);

  const adoptGlobalModelOverride = useCallback((globalModelOverride: string) => {
    setSnapshot((previous) => (previous ? { ...previous, globalModelOverride } : previous));
    setDraft((previous) => (previous ? { ...previous, globalModelOverride } : previous));
    // The field-level errors belonged to the request that just succeeded, and
    // `globalModelOverride` now matches the saved value, so nothing is pending.
    setFieldErrors((previous) => {
      if (Object.keys(previous).length === 0) return previous;
      const next = { ...previous };
      delete next.globalModelOverride;
      return next;
    });
    setSaveStatus(null);
  }, []);

  const dirty = useMemo(
    () => (snapshot && draft ? isDirty(snapshot, draft) : false),
    [snapshot, draft],
  );

  return {
    snapshot,
    draft,
    fieldErrors,
    loading,
    loadError,
    saving,
    saveStatus,
    dirty,
    reload: () => void reload(),
    updateDraft,
    discard,
    save: () => void save(),
    adoptGlobalModelOverride,
  };
}
