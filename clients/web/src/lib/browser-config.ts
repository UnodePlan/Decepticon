export interface BrowserConfig {
  langGraphApiUrl: string;
  terminalWsUrl: string;
}

/** Overrides the operator saved on the settings page; absent/empty = deployment value. */
export interface StoredBrowserEndpoints {
  langGraphBrowserUrl?: string;
  terminalBrowserUrl?: string;
}

// Pass process.env from the request-time server component: direct
// process.env.NEXT_PUBLIC_* references would be frozen by next build.
//
// A stored override wins over the deployment value so the settings page's Web
// Endpoints card is not a save button without an effect. The caller passes
// `undefined` when the database is unreachable or has no row, which keeps the
// deployment value (and therefore today's behaviour) intact.
export function browserConfig(
  env: Record<string, string | undefined>,
  stored?: StoredBrowserEndpoints,
): BrowserConfig {
  return {
    langGraphApiUrl:
      stored?.langGraphBrowserUrl?.trim() ||
      env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
      "http://localhost:2024",
    terminalWsUrl:
      stored?.terminalBrowserUrl?.trim() ||
      env.NEXT_PUBLIC_TERMINAL_WS_URL ||
      "ws://localhost:3003",
  };
}

interface BrowserLocation {
  protocol: string;
  host: string;
}

export function langGraphApiUrl(location: BrowserLocation, endpoint: string): string {
  const url = new URL(endpoint, `${location.protocol}//${location.host}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("LangGraph requires HTTP or HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export function terminalWebSocketUrl(location: BrowserLocation, endpoint: string): URL {
  const url = new URL(endpoint, `${location.protocol}//${location.host}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("Terminal requires WS or WSS");
  }
  return url;
}
