import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-bridge";
import { testModel, type SettingsApiDeps } from "@/lib/system-settings-api";
import { prismaSettingsStore } from "@/lib/system-settings-store";

/**
 * Probe whether a model id is registered with the LiteLLM proxy.
 *
 * The dashboard calls this from the model settings card so an operator can tell a
 * typo from an upstream outage BEFORE saving. The credential is read server-side
 * from the stored override (or the deployment env) and never reaches the browser;
 * upstream failures are collapsed into 502 so no header/body detail leaks.
 */

const deps: SettingsApiDeps = { store: prismaSettingsStore, authenticate: requireAuth };

export async function POST(request: Request): Promise<NextResponse> {
  return testModel(request, deps);
}
