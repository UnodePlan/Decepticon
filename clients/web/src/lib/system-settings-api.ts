/**
 * Settings route handlers — all of the HTTP behaviour, none of the wiring.
 *
 * The route files under `src/app/api/settings/**` are three-line adapters that
 * inject the real Prisma store and `requireAuth`; everything testable
 * (validation, secret redaction, error contract, upstream probing) lives here so
 * it can be exercised without a database, a session cookie or a live proxy.
 *
 * Error contract, identical for every handler:
 *   401 `{ error }`                      unauthenticated
 *   400 `{ error, fields? }`             malformed JSON / invalid or unknown field
 *   500 `{ error }`                      storage failure (no driver detail)
 *   502 `{ error }`                      upstream proxy unreachable/misconfigured
 * Responses NEVER contain the stored proxy credential, not even partially.
 */

import { NextResponse } from "next/server";
import { AuthError } from "./auth-bridge";
import {
  loadSettings,
  saveSettings,
  settingsProxyUrl,
  type SettingsStore,
} from "./system-settings-runtime";
import {
  MODEL_ROLE_IDS,
  SETTINGS_LIMITS,
  validateSettingsPatch,
  type SettingsEnv,
} from "./system-settings";

export interface SettingsApiDeps {
  store: SettingsStore;
  /**
   * Injected so the handlers stay decoupled from `next/headers`: route files pass
   * `requireAuth`, tests pass a stub.
   */
  authenticate: () => Promise<unknown>;
  env?: SettingsEnv;
  /** Probe seam so the model test does not need a live LiteLLM. */
  fetchImpl?: typeof fetch;
}

const PROBE_TIMEOUT_MS = 5000;

/** Map an authentication failure onto the 401/500 contract. */
function authFailure(error: unknown): NextResponse {
  return error instanceof AuthError
    ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    : NextResponse.json({ error: "Settings unavailable" }, { status: 500 });
}

/** GET /api/settings — effective settings + read-only startup facts. */
export async function getSettings(deps: SettingsApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  try {
    const { snapshot } = await loadSettings(deps.store, deps.env);
    return NextResponse.json(snapshot);
  } catch {
    // Never echo the driver message: it embeds the connection string.
    return NextResponse.json({ error: "Failed to read settings" }, { status: 500 });
  }
}

/** PUT /api/settings — partial update; absent fields keep their stored value. */
export async function putSettings(request: Request, deps: SettingsApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const validated = validateSettingsPatch(body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: validated.error, ...(validated.fields ? { fields: validated.fields } : {}) },
      { status: 400 },
    );
  }

  try {
    const { snapshot } = await saveSettings(validated.patch, deps.store, deps.env);
    return NextResponse.json(snapshot);
  } catch {
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}

/**
 * POST /api/settings/test-model — is this model id registered with LiteLLM?
 *
 * A model missing from `/v1/models` is a successful probe (`{ ok: false }`); an
 * unreachable or unauthorised proxy is 502. The credential is read server-side and
 * never echoed, and no upstream header/body is forwarded to the browser.
 */
export async function testModel(request: Request, deps: SettingsApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const probe = readProbeBody(raw);
  if (typeof probe === "string") return NextResponse.json({ error: probe }, { status: 400 });

  let apiKey: string;
  try {
    ({ apiKey } = await loadSettings(deps.store, deps.env));
  } catch {
    // Storage failure, not an upstream problem: keep the two distinguishable.
    return NextResponse.json({ error: "Failed to read settings" }, { status: 500 });
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "No LiteLLM credential configured — set one in settings or the deployment environment" },
      { status: 502 },
    );
  }

  let models: string[];
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${settingsProxyUrl(deps.env)}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ error: `LiteLLM returned HTTP ${response.status}` }, { status: 502 });
    }
    models = registeredModels(await response.json().catch(() => null));
  } catch {
    return NextResponse.json({ error: "LiteLLM proxy unreachable" }, { status: 502 });
  }

  const ok = models.includes(probe.model);
  return NextResponse.json({
    ok,
    model: probe.model,
    detail: ok
      ? "Registered with the LiteLLM proxy"
      : `Not registered (${models.length} models available)`,
  });
}

interface ProbeBody {
  model: string;
  role?: string;
}

function readProbeBody(input: unknown): ProbeBody | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "Request body must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return "model is required";
  if (model.length > SETTINGS_LIMITS.modelIdLength || /\s/.test(model)) {
    return "model must be a single model id";
  }
  if (body.role === undefined || body.role === null) return { model };
  if (typeof body.role !== "string" || !MODEL_ROLE_IDS.includes(body.role)) {
    return "role must be a known agent id";
  }
  return { model, role: body.role };
}

/** Registered model ids from a LiteLLM `/v1/models` payload. */
function registeredModels(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    const id = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}
