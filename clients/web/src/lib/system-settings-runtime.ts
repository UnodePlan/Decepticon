/**
 * Server-side settings plumbing — pure half.
 *
 * Snapshot assembly, patch persistence and credential resolution on top of the
 * pure contract in `./system-settings`. Deliberately free of Prisma imports so
 * it can be unit-tested without a database; the Prisma-backed store lives in
 * `./system-settings-store`.
 */

import {
  SETTING_KEYS,
  encodeSettingValue,
  maskSecretState,
  parseSettingsRows,
  settingsEnvironment,
  storedApiKey,
  type SettingRow,
  type SettingsEnv,
  type SettingsPatch,
  type SettingsSnapshot,
  type WritableSettingField,
} from "./system-settings";

/** A single stored-key change; a `null` value deletes the row (back to the default). */
export interface SettingsChange {
  key: string;
  value: string | null;
}

/** Storage seam — Prisma implementation in `./system-settings-store`, fakes in tests. */
export interface SettingsStore {
  read(): Promise<SettingRow[]>;
  write(changes: SettingsChange[]): Promise<void>;
}

/** Settings plus the resolved proxy credential (never returned to the client). */
export interface LoadedSettings {
  snapshot: SettingsSnapshot;
  /** Stored override, else the deployment env credential; empty when unset. */
  apiKey: string;
}

/**
 * Full snapshot: stored rows merged over deployment defaults, plus the
 * read-only startup facts.
 */
export function snapshotFromRows(rows: SettingRow[], env: SettingsEnv = process.env): SettingsSnapshot {
  const deployment = settingsEnvironment(env);
  return {
    ...parseSettingsRows(rows, env),
    llmProxyApiKeySet: maskSecretState(storedApiKey(rows.find((row) => row.key === SETTING_KEYS.llmProxyApiKey))),
    authMode: deployment.authMode,
    databaseConfigured: deployment.databaseConfigured,
    deploymentWebPort: deployment.deploymentWebPort,
    // Startup-scoped: the agent process, the telemetry sink singleton and the
    // embedding dimension all resolve these from their own environment, so the
    // dashboard reports them instead of pretending it could edit them.
    telemetryMode: deployment.telemetryMode,
    authPriority: deployment.authPriority,
    skillogyEmbedModel: deployment.skillogyEmbedModel,
  };
}

/** Read + merge, and resolve the credential the proxy calls must use. */
export async function loadSettings(
  store: SettingsStore,
  env: SettingsEnv = process.env,
): Promise<LoadedSettings> {
  const rows = await store.read();
  return {
    snapshot: snapshotFromRows(rows, env),
    apiKey: storedApiKey(rows.find((row) => row.key === SETTING_KEYS.llmProxyApiKey)) || environmentApiKey(env),
  };
}

/**
 * Apply a validated patch and return the settings as they now stand.
 * Values that encode to `null` (empty string / empty map) delete their row, so
 * clearing a field restores the deployment default.
 */
export async function saveSettings(
  patch: SettingsPatch,
  store: SettingsStore,
  env: SettingsEnv = process.env,
): Promise<LoadedSettings> {
  await store.write(
    Object.entries(patch).map(([field, value]) => ({
      key: SETTING_KEYS[field as WritableSettingField],
      value: encodeSettingValue(field as WritableSettingField, value),
    })),
  );
  return loadSettings(store, env);
}

/**
 * Credential used when no dashboard override is stored. Mirrors the stack: the
 * agent core reads `DECEPTICON_LLM__PROXY_API_KEY`, while the health endpoint
 * accepts the compose-provided `LITELLM_MASTER_KEY` (and `LITELLM_API_KEY`).
 */
export function environmentApiKey(env: SettingsEnv = process.env): string {
  return (
    env.DECEPTICON_LLM__PROXY_API_KEY?.trim() ||
    env.LITELLM_API_KEY?.trim() ||
    env.LITELLM_MASTER_KEY?.trim() ||
    ""
  );
}

/**
 * LiteLLM base URL used by the model-registration probe. `DECEPTICON_LLM__PROXY_URL`
 * is what the agent core targets; `LITELLM_URL` is what the compose stack (and the
 * health endpoint) uses — accept either, then fall back to the in-network service.
 */
export function settingsProxyUrl(env: SettingsEnv = process.env): string {
  const url = env.DECEPTICON_LLM__PROXY_URL?.trim() || env.LITELLM_URL?.trim() || "http://litellm:4000";
  return url.replace(/\/+$/, "");
}
