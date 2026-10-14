import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-bridge";
import { getSettings, putSettings, type SettingsApiDeps } from "@/lib/system-settings-api";
import { prismaSettingsStore } from "@/lib/system-settings-store";

/**
 * Operator-editable runtime settings.
 *
 * GET  → current effective settings plus the read-only startup facts.
 * PUT  → partial update; only the fields present in the body are touched.
 *
 * The stored LiteLLM credential is NEVER returned: responses carry only
 * `llmProxyApiKeySet`. Deployment-level configuration (ports, DATABASE_URL, auth
 * bootstrap) is reported read-only — it is injected by the launcher at container
 * start, so the UI labels it "takes effect after restart" instead of pretending a
 * `.env` edit was hot-reloaded.
 *
 * Error contract: 401 unauthenticated · 400 malformed JSON or invalid fields
 * (`{ error, fields? }`) · 500 storage failure, without echoing driver detail.
 */

const deps: SettingsApiDeps = { store: prismaSettingsStore, authenticate: requireAuth };

export async function GET(): Promise<NextResponse> {
  return getSettings(deps);
}

export async function PUT(request: Request): Promise<NextResponse> {
  return putSettings(request, deps);
}
