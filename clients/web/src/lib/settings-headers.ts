/**
 * Extra-header contract — the ONE definition of which provider request headers
 * an operator may set, and the only shape in which they may leave the server.
 *
 * PURE and dependency-free (like the rest of the settings contract): it is
 * imported by the browser form and by the route handlers, so nothing Node-only
 * may appear here. Header VALUES are credentials-adjacent: they are never
 * echoed back to the browser and never logged — {@link extraHeaderNames} is the
 * only projection of a header map that may cross that boundary.
 *
 * The same rule backs the custom LLM channel (`./llm-channel`), so a header the
 * channel accepts can never differ from one the global settings accept.
 */

/** Key count / per-value length limits, shared with `SETTINGS_LIMITS`. */
export const EXTRA_HEADER_LIMITS = {
  maxEntries: 32,
  valueLength: 2048,
} as const;

/**
 * Header names that must never be operator-settable: they carry credentials or
 * frame the request, and a stored value would leak the deployment's own
 * authentication. Mirrors `llm/factory.py::_PROTECTED_EXTRA_HEADERS` plus the
 * cookie pair, which the plan calls out explicitly.
 */
export const FORBIDDEN_LLM_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
] as const;

/** RFC 7230 field-name; also excludes whitespace and control characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Is this a header name an operator may set? The single predicate behind
 * {@link sanitizeExtraHeaders} AND the browser form (`./llm-channel-form`),
 * which blocks a bad name before a request is made instead of re-deriving the
 * rule.
 */
export function isValidExtraHeaderName(name: string): boolean {
  const candidate = name.trim().toLowerCase();
  return (
    candidate !== "" &&
    HEADER_NAME.test(candidate) &&
    !(FORBIDDEN_LLM_HEADER_NAMES as readonly string[]).includes(candidate)
  );
}

/**
 * The one implementation of the extra-header rule. Every other entry point
 * (env parsing, the channel form) funnels through it, so an acceptable header
 * can never differ between the places that accept one.
 */
function scanExtraHeaders(value: unknown): { headers: Record<string, string> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `must be an object of at most ${EXTRA_HEADER_LIMITS.maxEntries} headers` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > EXTRA_HEADER_LIMITS.maxEntries) {
    return { error: `must have at most ${EXTRA_HEADER_LIMITS.maxEntries} headers` };
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (typeof rawValue !== "string") return { error: `header "${name}" must have a string value` };
    if (!isValidExtraHeaderName(rawName)) {
      const forbidden = (FORBIDDEN_LLM_HEADER_NAMES as readonly string[]).includes(name);
      return { error: forbidden ? `header "${name}" cannot be overridden` : `"${rawName}" is not a valid header name` };
    }
    if (rawValue.length > EXTRA_HEADER_LIMITS.valueLength) {
      return { error: `header "${name}" must be at most ${EXTRA_HEADER_LIMITS.valueLength} characters` };
    }
    if (/[\r\n\0]/.test(rawValue)) return { error: `header "${name}" must not contain line breaks` };
    headers[name] = rawValue;
  }
  return { headers };
}

/** A stored/env value: `null` when it does not satisfy the rule. */
export function sanitizeExtraHeaders(value: unknown): Record<string, string> | null {
  const scanned = scanExtraHeaders(value);
  return "headers" in scanned ? scanned.headers : null;
}

/** A request-body value: the field error message when it does not satisfy the rule. */
export function validateExtraHeaders(value: unknown): Record<string, string> | string {
  const scanned = scanExtraHeaders(value);
  return "headers" in scanned ? scanned.headers : scanned.error;
}

/**
 * Names of the configured extra headers. This is the ONLY shape in which extra
 * headers may leave the server: values are credentials-adjacent and never
 * echoed back to the browser.
 *
 * HTTP field names are case-insensitive and the stored map is lower-cased, but
 * the normalisation is applied HERE too: an operator-supplied string (a hand-typed
 * row, an older row written before `sanitizeExtraHeaders` lower-cased) must never
 * surface as `X-Trace` next to `x-tenant`. Two casings of one name collapse to a
 * single entry.
 */
export function extraHeaderNames(headers: Record<string, string> | null | undefined): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(headers ?? {})) names.add(name.trim().toLowerCase());
  return [...names].sort();
}

/**
 * `DECEPTICON_LLM_EXTRA_HEADERS`: a JSON object of string headers. Malformed
 * input, non-string values and protected header names are dropped — the agent
 * core raises on them, but the settings page must still render.
 *
 * The agent process resolves this variable from its OWN environment
 * (`llm/factory.py::_resolve_extra_headers`) at construction time; the dashboard
 * only reports what it sees, never writes it.
 */
export function parseExtraHeadersEnv(raw: string | undefined): Record<string, string> {
  const value = raw?.trim() ?? "";
  if (!value) return {};
  try {
    return sanitizeExtraHeaders(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}
