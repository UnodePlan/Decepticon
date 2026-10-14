import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-bridge";
import { testChannel, type ChannelApiDeps } from "@/lib/llm-channel-api";
import { registerChannelModel } from "@/lib/llm-channel-proxy";
import { prismaSettingsStore } from "@/lib/system-settings-store";

/**
 * POST /api/settings/llm-channel/test — prove an unsaved draft answers.
 *
 * Body: `{ apiBase, protocol, model, apiKey?, keyless, maxOutputTokens?, extraHeaders? }`. The
 * server sends ONE minimal request to the operator's endpoint the way the proxy
 * will (protocol path, protocol credential header, capped output tokens) and
 * returns `{ ok, detail }` with fixed wording: no upstream body, header, status
 * text or credential is forwarded. `extraHeaders` are attached to the probe (blank
 * value = the stored one, same base only) because a header is often part of what the
 * endpoint needs to answer.
 *
 * Error contract: 401 · 400 (invalid body/fields) · 500 storage failure ·
 * 502 unreachable/redirecting endpoint, 401 for a rejected credential, 404 when
 * the protocol's route does not exist on the endpoint.
 */

const deps: ChannelApiDeps = {
  store: prismaSettingsStore,
  authenticate: requireAuth,
  register: registerChannelModel,
};

export async function POST(request: Request): Promise<NextResponse> {
  return testChannel(request, deps);
}
