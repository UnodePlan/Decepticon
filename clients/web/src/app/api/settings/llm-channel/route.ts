import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-bridge";
import { getChannel, putChannel, type ChannelApiDeps } from "@/lib/llm-channel-api";
import { registerChannelModel, removeChannelModel } from "@/lib/llm-channel-proxy";
import { prismaSettingsStore } from "@/lib/system-settings-store";

/**
 * Operator-supplied custom LLM channel: OpenAI-compatible `/chat/completions`,
 * OpenAI `/responses`, or the native Anthropic Messages `/v1/messages`.
 *
 * GET → `{ apiBase, apiKeySet, model, protocol, protocols, contextWindowTokens,
 *         maxOutputTokens, extraHeadersSet }`; neither the key nor a header value
 *         is ever returned.
 * PUT → validate the endpoint, register the chosen model with LiteLLM under a
 *       Decepticon-owned alias, and persist the channel plus the global model
 *       override in one transaction. `{ model: "" }` clears the channel and only
 *       unsets the global override while it still points at this channel's alias.
 *
 * Error contract: 401 unauthenticated · 400 malformed body/invalid field
 * (`{ error, fields? }`) · 500 storage failure · 502 upstream endpoint or LiteLLM
 * failure. No response carries the channel credential or an upstream body.
 */

const deps: ChannelApiDeps = {
  store: prismaSettingsStore,
  authenticate: requireAuth,
  register: registerChannelModel,
  unregister: removeChannelModel,
};

export async function GET(): Promise<NextResponse> {
  return getChannel(deps);
}

export async function PUT(request: Request): Promise<NextResponse> {
  return putChannel(request, deps);
}
