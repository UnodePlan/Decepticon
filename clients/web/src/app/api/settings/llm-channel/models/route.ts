import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-bridge";
import { discoverModels, type ChannelApiDeps } from "@/lib/llm-channel-api";
import { registerChannelModel } from "@/lib/llm-channel-proxy";
import { prismaSettingsStore } from "@/lib/system-settings-store";

/**
 * POST /api/settings/llm-channel/models — the model ids the operator's endpoint
 * advertises, for the picker on the settings page.
 *
 * Body: `{ apiBase, protocol, apiKey?, extraHeaders? }`. An absent key reuses the stored one ONLY
 * when the base is unchanged, so a base the operator just typed is never contacted
 * with the previous endpoint's credential; send `apiKey: ""` for a keyless
 * endpoint. `extraHeaders` are the draft's own plain rows (blank value = reuse the
 * stored value for that name, same base only) so an endpoint that needs a header to
 * answer its listing is listed correctly instead of reported as unreachable. The credential stays on the server and upstream bodies/headers are
 * never forwarded. A protocol with no standard listing (Anthropic Messages)
 * answers `{ models: [], manual: true }` instead of inventing a listing.
 *
 * Error contract: 401 · 400 (invalid body/base/protocol, or a key that cannot be
 * reused) · 500 storage failure · 502 endpoint unreachable/redirecting/rejecting
 * the key. An unknown protocol, or one without a listing, is 400 — never a silent
 * downgrade to another route.
 */

const deps: ChannelApiDeps = {
  store: prismaSettingsStore,
  authenticate: requireAuth,
  register: registerChannelModel,
};

export async function POST(request: Request): Promise<NextResponse> {
  return discoverModels(request, deps);
}
