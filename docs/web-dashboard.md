# Web Dashboard

The web dashboard is an open-source (Apache 2.0) browser-based control plane for managing engagements. It runs alongside the terminal CLI — use whichever interface fits your workflow.

**Stack**: Next.js 16 · React 19 · PostgreSQL (Prisma) · Neo4j · React Flow · Tailwind CSS v4

---

## Running the Dashboard

**End users:**
```bash
decepticon                    # starts the core stack + drops into the terminal CLI
```

The dashboard is **dynamic-spawn** (v1.1.8+): it does NOT come up on `decepticon start`. Bring it up from inside the CLI with the `/web` slash command, then open <http://localhost:3000>:

| CLI command | Effect |
|---|---|
| `/web` (or `/web up`) | `docker compose --profile web up -d web` against the host daemon |
| `/web down` (or `/web stop`) | stops the container; preserves it so the next `/web up` is fast |
| `/web url` | prints `http://localhost:${WEB_PORT}` without touching docker |
| `/dashboard` | alias for `/web` |

**Desktop app (contributors):**
```bash
npm run desktop
```

The desktop app is an Electron shell for the product UI:

| Mode | When | Target |
|---|---|---|
| `auto` (default) | Local install present → local; otherwise cloud | `http://localhost:${WEB_PORT:-3000}` or `https://app.decepticon.red` |
| `cloud` | `DECEPTICON_DESKTOP_MODE=cloud` | Hosted app (website login, Google/GitHub OAuth in-window) |
| `local` | `DECEPTICON_DESKTOP_MODE=local` | Local dashboard; auto-starts the `web` Docker Compose profile from `~/.decepticon` when offline |

Sessions use a persistent Electron partition (`persist:decepticon-desktop`). Optional one-shot cookie import: drop a Cookie-Editor JSON or Netscape export at `~/.decepticon/desktop-cookies.txt` (Windows: `%USERPROFILE%\.decepticon\desktop-cookies.txt`) or set `DECEPTICON_DESKTOP_COOKIES`. Prefer interactive sign-in; never commit session tokens.

Cross-platform notes (Linux / macOS / Windows):

| Concern | Behavior |
|---|---|
| Install copy-button | `install.sh` on Unix; `install.ps1` + winget Docker hint on Windows |
| Local stack start | `docker compose …` via argv spawn (`shell: false`); `windowsHide` on Windows |
| Login form edit keys | Application **Edit** menu roles (required for Cmd/Ctrl+C/V on all three) |
| Window lifecycle | macOS stays running after last window close (dock re-activate); others quit |
| CI | `Desktop (ubuntu/macOS/windows)` runs unit + syntax checks on every desktop change |

External links stay in the system browser; status UI matches the product branding when bootstrap is blocked.

Headless operators (no CLI, e.g. CI) can drive the same lifecycle from the host shell:
```bash
docker compose -p decepticon --profile web up -d --no-build web
```

**Contributors (full stack with hot-reload):**
```bash
make dev
```
Builds and starts every service with source-sync hot-reload. The web service still requires the `web` profile to be active — e.g. `COMPOSE_PROFILES=web make dev` — or bring it up after the fact with `/web up`. Open <http://localhost:3000>.

**Contributors (local Next.js dev server):**
```bash
make web-dev
```
Runs the Next.js dev server locally on the host while infra (postgres, neo4j, litellm, langgraph, sandbox) stays in Docker. Faster web iteration than `make dev`.

On macOS the terminal bridge spawns PTYs through node-pty's own
`prebuilds/darwin-<arch>/spawn-helper`, which the published stable tarball
(1.1.0) carries as mode `0644` — `posix_spawnp` refuses it and the browser
terminal reports the bare `posix_spawnp failed.` The terminal server repairs the
mode before it starts listening (one `chmod` on the helper it will actually
exec) and logs the path; if the tree is root-owned or read-only it prints the
`chmod +x` line to run instead. A manual fix, if you ever need one:
`chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`.

The PTY is started with `node --import tsx <cli>/src/index.tsx` — the default
tsx entry, not `tsx/esm`. tsx 4.22.0's ESM-only entry installs just the module
hooks, and its sync load hook rewrote every JSON module (`format: "json"`) into
ESM source, including the ones a CommonJS `require()` still parses as JSON. Ink
requires `cli-boxes/boxes.json`, so on Node 24.11/25.1 every PTY died with
`Unexpected token 'v', "var single"... is not valid JSON` before painting its
first frame (tsx fixed the ESM hook in 4.22.2). The default entry installs the
CJS hook as well, so `--import tsx` runs the CLI on every supported Node.
`src/lib/terminal-startup-lifecycle.test.ts` pins both the specifier and a real
`require('./x.json')` probe.

The browser terminal keeps **one** WebSocket per mounted terminal. `connectWs`
refuses to dial while the current socket is `CONNECTING` or `OPEN`, and every
socket handler (open, message, close, error) ignores events whose socket is no
longer the current one. Without that check a superseded socket's close event is
indistinguishable from a dropped link, so a replacement scheduled a reconnect
for the *live* connection, the replacement's `open` reset the retry counter, and
the client opened a fresh socket every second forever — the server logged a
`disconnect`/`reattach` pair per cycle on one pid while the client re-ran
`term.reset()` plus the replayed scrollback, which the operator sees as the
banner flashing once a second and never accepts a prompt. A dropped connection
still reconnects silently with exponential backoff (1s → 4s, 15 attempts), a
reattach still replays scrollback after `term.reset()`, and the 15s heartbeat
still pings and closes a socket that answers nothing within 5s. Two jsdom
component tests pin the visible half — `terminal-reconnect`
(`src/lib/terminal-reconnect.test.ts`) and `terminal-unmount`: one socket per
remount, a stale socket's frames and close events never reaching the live
terminal, one input listener across reconnects with each keystroke sent once, a
responsive socket left alone by the heartbeat, and a teardown that schedules no
retry.

Output does not go to xterm one WebSocket frame at a time. An Ink repaint arrives
as many small fragments, and writing each one separately made xterm repeat its
write/render bookkeeping per fragment — in a headless Chromium fixture mirroring
the pane (180 frames × 8 fragments, three mounted terminals as in the
plan/red/blue switcher) that was 1440 `write()` calls and 8142 DOM mutations on
the visible pane. `src/lib/terminal-output-coalescer.ts` batches fragments that
arrive within one animation frame into a single write, in arrival order: same
fixture → 180 calls / 1409 mutations, and the two hidden panes 1440 → 180 calls
each, with an identical terminal buffer digest (same bytes, same order). A batch
flushes early at **256 KB** and at the latest **50 ms** after its first fragment,
so a throttled background tab (where `requestAnimationFrame` may not fire) cannot
hold output; a clean close and the retry banner flush the pending batch first, and
a `reattached` reset drops bytes buffered before it instead of replaying them over
the reset. Without `requestAnimationFrame` (the jsdom test harness) `push()` writes
straight through, which is why the lifecycle tests are unaffected.
`src/lib/terminal-output-coalescing.test.ts` pins that contract.

Fitting is skipped while the pane has no usable area. The drawer animates its
width to 0, but the container keeps 8px of padding, so a collapse left ~16px of
*usable* width for several frames — enough to pass the old `clientWidth === 0`
guard, clamp the terminal to xterm's 2-column minimum and resize the PTY, which
made the CLI reflow its whole frame twice (`47×30 → 2×30 → 46×30` and 438 buffer
lines of reflowed history in the fixture, versus a single `47×30` and 30 lines
now). The observer now requires a usable terminal-surface rect (≥ 24×24) and sends
a resize message only when the grid actually changed.

---

## Features

### Language (English / 中文)

The console ships with an English and a Simplified Chinese UI. Pick a language
from the switch in the header (and on the sign-in card); the choice is stored in
the `decepticon_lang` cookie *and* localStorage, so it survives reloads and is
shared by every open tab. With no stored choice the UI falls back to
`DECEPTICON_LANGUAGE` (`en` or `zh`; anything else renders English).

Copy lives in `clients/web/src/lib/i18n.ts` — a flat `en` dictionary typed as the
source of truth plus a `zh` record that must cover every key (`npm test` fails if
a key is missing). Components read it through the `useI18n()` hook from
`clients/web/src/lib/i18n-context.tsx`, which the root layout mounts with the
cookie value resolved on the server, so the first paint is already in the right
language.

### Engagement Setup

Create an engagement with one target and authorization reference. Choose Red
for direct execution, Plan for optional Soundwave planning, or Blue for local
sensor investigation. The current direct-scope form accepts:

| Type | Example |
|------|---------|
| IP range | `10.0.0.0/24` |
| Web URL | `https://app.example.com` |

### Soundwave Interview

Plan mode runs Soundwave's interview in the terminal and builds the eight-document
bundle. Red mode can start without this interview from the confirmed direct RoE.
To move from Plan to Red, review the documents and approve the validated bundle
with the mode selector. Blue mode checks the local sensor before opening its
defensive agent. Each mode keeps its own terminal session and LangGraph thread.

### Execution Streaming

Once an engagement is running, the dashboard streams all agent events via Server-Sent Events (SSE) from LangGraph. You see tool calls, agent outputs, and objective status updates as they happen.

### Findings Viewer

Parses `FIND-NNN.md` reports from `workspace/findings/` and presents them in a structured view:
- Severity filter (CRITICAL / HIGH / MEDIUM / LOW / INFO)
- Per-finding detail: description, evidence, CVSS, CWE, MITRE technique
- Remediation recommendation

### Attack Graph Canvas

Interactive visualization of the Neo4j knowledge graph:
- Pan and zoom
- Click any node for full property detail
- Color-coded by node type (Host, Service, Vulnerability, Credential)
- Live — updates as the agent adds nodes and edges

Powered by [React Flow](https://reactflow.dev/) with `d3-force` for graph layout.

Graph edges are drawn without React Flow's `animated` flag: the `dashdraw`
keyframe repaints every edge for as long as the page is open, which on a
knowledge graph that only changes when the agent writes to it is permanent work
for a static picture.

### Live Agent Graph (`/engagements/<id>/live`)

The force-directed execution graph draws every agent, its tool satellites and
the edges between them, and its cost is dominated by animation — the whole SVG
re-renders on every simulation tick and every streamed event:

- Node activity is shown by a ring `<circle>` whose keyframes animate only
  `transform` and `opacity`. The earlier `filter: drop-shadow()` keyframes
  re-ran a Gaussian blur over each node every frame (关键原因：filter 动画每帧重跑
  模糊，随节点数线性放大).
- Edge traffic dots are moved along the path by SMIL `<animateMotion>`, which
  re-rasterizes them every frame, so they carry no `filter`; their warm glow is
  fill/opacity instead of a blur + drop-shadow chain (关键原因：被过滤的图层每帧
  重新模糊，每条活跃边三个点对).
- The `d3-force` loop only runs while a run is active **and** the document is
  visible. Otherwise the layout is published once and the timer stays off —
  the hidden tab is why a background canvas kept repainting (关键原因：hidden tab
  仍会拿到动画帧).
- `deriveAgentActivity` reuses a node object when nothing visible changed, so a
  streamed event re-renders only the nodes it touched.

Measured by rendering the real node/edge components (49 nodes, 48 active edges,
288 SMIL dots) in a headless Chromium fixture and reading CDP
`Performance.getMetrics` over 3 s: 4.9 → 58.1 fps, worst frame gap 268 ms →
44 ms (page-level frame/task numbers, not GPU utilisation). Dropping only the
edge-dot filters accounted for most of it (5.5 → 51.3 fps).

### OPPLAN Tracker

Per-objective progress board:
- Status badges: `pending` / `in-progress` / `completed` / `blocked` / `cancelled`
- MITRE ATT&CK technique IDs per objective
- OPSEC level indicator
- Dependency graph (which objectives must complete before this one starts)

---

## Sign-in

The dashboard is guarded by a single administrator account. With no credential
configured it **fails closed**: every page redirects to `/login?next=…`, every
API route answers `401`, and the login card says authentication is not
configured. Nothing is hard-coded and no default password ships.

`decepticon start` provisions the sign-in material for you the first time it
sees a `.env` without it: it writes `DECEPTICON_SESSION_SECRET` and
`DECEPTICON_INTERNAL_API_TOKEN` (both random) and, unless you already chose a
credential, an administrator password whose **hash** is stored — the plaintext
is printed once at startup, so record it then. Re-running `start` never rotates
a credential you already have.

To choose your own credentials, put them in `~/.decepticon/.env` (or the repo
`.env` for `make web-dev`):

```env
DECEPTICON_ADMIN_USERNAME=admin
DECEPTICON_ADMIN_PASSWORD_HASH=scrypt$<saltHex>$<derivedKeyHex>
DECEPTICON_SESSION_SECRET=<openssl rand -hex 32>
```

Generate the hash without writing the password anywhere:

```bash
cd clients/web && npx tsx -e \
  "import {hashPassword} from './src/lib/auth-crypto'; console.log(await hashPassword(process.argv[1]))" \
  -- 'your-password'
```

`DECEPTICON_ADMIN_PASSWORD` (plaintext, hashed in memory on first use) is
accepted as a convenience alternative and logs a warning while active.
`pbkdf2$sha256$<iterations>$<saltHex>$<derivedKeyHex>` hashes are accepted too.
See the "Web dashboard authentication" block in `.env.example`.

| Piece | Behaviour |
|---|---|
| Session | HMAC-SHA256-signed `decepticon_session` cookie, `HttpOnly`, `SameSite=Lax`, `Secure` whenever the request arrives over HTTPS, 7-day expiry |
| Route guard | `clients/web/src/proxy.ts` (Next.js 16's rename of `middleware.ts`) — public: `/login`, `/api/auth/*`, `/api/health`, static assets |
| Pages | `/login?next=<path>` redirect; `next` is honoured only when it is a same-origin path |
| APIs | `401 {"error":"Unauthorized"}`; `requireAuth()` in `src/lib/auth-bridge.ts` still throws `AuthError`, so existing handlers are unchanged |
| Ownership | A session resolves to `userId = "local"`, the id every pre-existing `Engagement` row already carries — signing in never hides old engagements |
| Throttle | 10 failed attempts per 5-minute window per client address, then `429` with `Retry-After` |
| Terminal WS | `server/terminal-server.ts` validates the same cookie at upgrade time (it never passes through the Next.js router) |
| Internal calls | The terminal server PATCHes its own API with `x-decepticon-internal-token:` `DECEPTICON_INTERNAL_API_TOKEN` (generated at first start). Unset → no bypass |
| Dev escape hatch | `DECEPTICON_AUTH_DISABLED=true` restores the pre-auth "local user" behaviour. Development only |

Sign out from the header; it clears the cookie via `POST /api/auth/logout`.

---

## Language

The console supports English and Chinese. The switch lives in the header (and
on the login card) and stores the choice in the `decepticon_lang` cookie plus
`localStorage`; URLs are never rewritten, so every route, API path, WebSocket
URL and deep link keeps working. `DECEPTICON_LANGUAGE` (default `en`) supplies
the initial value and the cookie wins afterwards. Dictionaries and the
`useI18n()` hook are in `clients/web/src/lib/i18n.ts` and
`clients/web/src/lib/i18n-context.tsx`; `src/lib/i18n.test.ts` enforces en↔zh
key parity.

---

## Database

The dashboard uses PostgreSQL with Prisma ORM.

**Run migrations** (after `git pull` with schema changes):
```bash
make web-migrate
```

**Regenerate Prisma client** (after editing `prisma/schema.prisma`):
```bash
cd clients/web && npx prisma generate
```
Or run `make web-build` to regenerate the client and build the dashboard in one step.

Schema is at `clients/web/prisma/schema.prisma`. Key models: `Engagement` and
`SystemSetting` (see below).

---

## Settings

`/settings` edits operator-tunable runtime settings; they are stored in the
`SystemSetting` key/value table so they survive container restarts without
touching `.env`.

The screen is split across three sidebar entries, each loading only its own
cards: `/settings/models` (custom LLM channel + model runtime),
`/settings/runtime` (runtime defaults, browser endpoints, startup values) and
`/settings/status` (system health, engagement stats, agent registry). The
bottom of the rail labels them under **Settings**, and the command palette has
one command per screen. `/settings` itself stays reachable as the overview and
is an exact-match nav target, so it never highlights a sub-entry.

Screen code: `clients/web/src/app/(dashboard)/settings/{models,runtime,status}/page.tsx`,
which share `components/settings/settings-page-shell.tsx` (heading, save bar,
load-failure alert) and `components/settings/use-settings-draft.ts` (the
load/validate/save cycle, one `GET /api/settings` per mount). The overview at
`settings/page.tsx` links to the three and performs no requests.

| Field | Stored key | Effect |
| --- | --- | --- |
| `modelProfile` | — (not storable) | **Reported read-only**, from `DECEPTICON_MODEL_PROFILE` (default `eco`). The agent process reads its own container env at startup, so a stored row would be a knob with no consumer; a legacy `model_profile` row is ignored, not applied, and `PUT` answers `400 { fields: { modelProfile: "read-only field" } }` |
| `globalModelOverride` | `global_model_override` | One model id for every agent. Applied by the **next terminal session**: the terminal server forwards it to the PTY and the CLI injects it into the run input |
| `modelOverrides` | `model_overrides` | `{<agent id>: <model id>}`; wins over the global override for that agent. Same next-session boundary |
| `language` | `language` | Dashboard default language on the next page request, when no `decepticon_lang` cookie is set; the cookie always wins |
| `llmTimeoutSeconds` | — (not storable) | **Reported read-only**, from `DECEPTICON_LLM__TIMEOUT` (else `DECEPTICON_LLM_TIMEOUT_SECONDS`, else `120`). The agent core resolves it at start; no Web-originated call uses the row (the model probe has its own 5 s budget), so a stored `llm_timeout_seconds` row is ignored |
| `llmMaxRetries` | — (not storable) | **Reported read-only**, same as the timeout (`DECEPTICON_LLM__MAX_RETRIES`, else `2`) |
| `langGraphBrowserUrl` | `langgraph_browser_url` | Browser dial target for the next page load; `NEXT_PUBLIC_LANGGRAPH_API_URL` (else the built-in default) applies when unset |
| `terminalBrowserUrl` | `terminal_browser_url` | WebSocket dial target for the next page load; `NEXT_PUBLIC_TERMINAL_WS_URL` (else the built-in default) applies when unset |
| `workspacePath` | — (not storable) | **Reported read-only**, from `WORKSPACE_PATH`. Engagement creation, the PTY and the workspace file APIs all resolve the root from the deployment env, so a stored row could not move the on-disk workspace. A legacy `workspace_path` row is ignored, not applied |
| `llmProxyApiKey` | `llm_proxy_api_key` | Used by the dashboard's model probe. Agent runs authenticate from the deployment env, so editing this row does not re-key them. **Write-only** — only `llmProxyApiKeySet` is ever returned |
| `reasoningEffort` | `reasoning_effort` | `none` / `low` / `medium` / `high` / `xhigh` / `max`, ascending; `none` sends no `reasoning_effort` at all. Applied by the **next terminal session**, and only to models that accept the parameter (the GPT-6 / Responses routes and the Claude family). The five non-`none` tiers travel **verbatim** through `DECEPTICON_RUN_REASONING_EFFORT` → run input → LiteLLM: the dashboard, the CLI and the run input never remap `xhigh`/`max` onto a lower tier, so a provider that does not know one fails loudly instead of silently running at `high`. Unset → `DECEPTICON_LLM_REASONING_EFFORT`, else `none` |
| `llmMaxOutputTokens` | `llm_max_output_tokens` | Output ceiling per response, `256`–`128000`. A value **below 64000 caps a model that would otherwise allow 128000**; matching the deployment value leaves the model's own ceiling alone. Unset → `DECEPTICON_LLM_MAX_TOKENS`, else `64000`. Same next-session boundary |
| `llmDisableStreaming` | `llm_disable_streaming` | Booleans only; buffers each response instead of streaming deltas. Unset → `DECEPTICON_LLM_DISABLE_STREAMING`. Same next-session boundary |
| `llmExtraHeaderNames` | — (not storable) | **Reported read-only**: the NAMES of the extra provider headers the agent process resolved from `DECEPTICON_LLM_EXTRA_HEADERS`. Values are credentials-adjacent, so they never leave the agent process — they are not stored in the settings table, not returned to the browser, not logged, and deliberately **not sent through the PTY env or the run input**, because the run input round-trips through the LangGraph checkpoint. They reach the provider only through `llm/factory.py::_resolve_extra_headers()` inside the agent process. At most 32 headers, values at most 2048 characters; `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `host` and `content-length` are refused there, as are control characters. A legacy `llm_extra_headers` row is not read |
| `budgetEngagementUsd` | `budget_engagement_usd` | USD hard cap for the whole engagement. Empty or `0` sends no per-run value at all, so the deployment's `DECEPTICON_BUDGET__ENGAGEMENT_USD` (usually `0`, i.e. unlimited) governs; a positive value overrides it for the next session's runs — and a run input may only ever **tighten** a cap the deployment set, never remove one. Same next-session boundary |
| `budgetPerAgentUsd` | `budget_per_agent_usd` | Same, for each specialist agent (`DECEPTICON_BUDGET__PER_AGENT_USD`) |
| `budgetSoftWarnAtPct` | `budget_soft_warn_at_pct` | Percent `0`–`100` at which the agent emits its budget warning. The UI edits percent; the run input carries the **fraction** the middleware compares against, so this maps onto `DECEPTICON_BUDGET__SOFT_WARN_AT_PCT` (`0.7`). Same next-session boundary |
| `hitlEnabled` | `hitl_enabled` | Turns on the operator-approval gate for the next terminal session's runs. It can only **enable** the gate: a deployment that set `DECEPTICON_HITL__ENABLED` to a truthy spelling keeps it on. Same next-session boundary |

Read-only deployment values reported in every snapshot (rejected by `PUT`):

| Field | Source | Why it is read-only here |
| --- | --- | --- |
| `telemetryMode` | `DECEPTICON_TELEMETRY` (`off` / `basic` / `research`), forced to `off` by `DO_NOT_TRACK` or an unknown value | The telemetry sink is a process-global singleton in the agent process, resolved at startup |
| `authPriority` | `DECEPTICON_AUTH_PRIORITY`, comma-separated `AuthMethod` slugs; an empty array means the built-in default chain | The model fallback chain is resolved when the agent builds its graph |
| `skillogyEmbedModel` | `DECEPTICON_SKILLOGY_EMBED_MODEL`, else `openai/text-embedding-3-small` | The embedding dimension is fixed at startup |
| `workspacePath` | `WORKSPACE_PATH` (the PTY and the workspace file APIs read it directly) | The workspace root is deployment-owned; a stored row had no consumer, so the field is no longer writable and any legacy `workspace_path` row is ignored on read |

Effect boundaries, in one place:

- **Next terminal session** — model overrides and every request-level knob above.
  The terminal server reads the snapshot before each PTY spawn and passes
  `DECEPTICON_RUN_MODEL_OVERRIDE{,S}`, `DECEPTICON_RUN_REASONING_EFFORT`,
  `DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS`, `DECEPTICON_RUN_LLM_DISABLE_STREAMING`,
  `DECEPTICON_RUN_BUDGET_*` and
  `DECEPTICON_RUN_HITL_ENABLED`; the CLI turns those into the run input the
  agent declares on `ModelOverridesState`. Values that equal the deployment
  default are omitted, so an untouched settings page produces a byte-identical
  run payload. A running PTY keeps the policy it started with.
- **Run input can only tighten** — a run may raise the guardrail posture
  (add/strengthen a budget cap, enable HITL) but never lower it: the run input is
  reachable by automated callers, so `0`/absent means "leave the deployment value
  alone" rather than "unlimited". The same rule is why `hitlEnabled` can only
  enable the gate.
- **Next page request** — `language` (below the cookie) and the two browser
  endpoints.
- **Reported read-only** — `authMode`, `databaseConfigured`, `deploymentWebPort`
  (launcher-injected) plus `telemetryMode`, `authPriority`, `skillogyEmbedModel`,
  `workspacePath`, `modelProfile`, `llmTimeoutSeconds`, `llmMaxRetries` and
  `llmExtraHeaderNames` (PTY/agent-process startup values). Each card names the env
  var that actually governs the row. They are never written to the settings table,
  and `PUT` answers `400 { fields: { <field>: "read-only field" } }` for each — there
  is no stored-but-unread category left, because a row nothing consumes only ever
  looks like a broken knob.
- **Server-side only** — `llmProxyApiKey`, and only for the dashboard's own
  outbound probe (badged as such); it does not re-key the agents. Extra-header
  *values* are likewise never echoed back to the browser or written to a log, and
  they have no dashboard-to-agent channel at all (see the `llmExtraHeaderNames` row
  above): the agent process resolves them from its own environment.
- `SETTINGS_EFFECT` in `clients/web/src/lib/system-settings.ts` is the machine-readable
  form of those labels (`next-session` / `read-only`), and
  `SETTINGS_ENV_SOURCE` names the environment variable that actually governs each
  read-only field. The cards render both, so a field cannot be described as
  live in the UI while the table above says otherwise.

Rules:

- Only the fields present in a `PUT` body are updated; everything else keeps its
  stored value. An empty string or empty map clears that row, so the deployment
  default (`DECEPTICON_MODEL_PROFILE`, `DECEPTICON_LANGUAGE`,
  `DECEPTICON_LLM__TIMEOUT`, `DECEPTICON_LLM__MAX_RETRIES`, `WORKSPACE_PATH`, …)
  applies again.
- Unknown fields, read-only fields, unknown agent ids in `modelOverrides` and
  out-of-range numbers are rejected with `400 { error, fields }`.
- The proxy credential is never echoed: responses carry `llmProxyApiKeySet:
  true/false` only, and that flag tracks the **stored override** — `false` means
  the deployment credential (`DECEPTICON_LLM__PROXY_API_KEY`, else
  `LITELLM_MASTER_KEY`) is in effect.
- `authMode`, `databaseConfigured` and `deploymentWebPort` describe the running
  container (launcher-injected) and are reported read-only — restart to change
  them. They are never written to the settings table.

Endpoints (both require a dashboard session): `GET`/`PUT /api/settings`, and
`POST /api/settings/test-model` with `{ model, role? }`, which checks the id
against LiteLLM's `/v1/models` before it is saved and returns `{ ok, model,
detail }` (`ok: false` means the probe worked but the model is not registered).

Contract, policy and storage live in `clients/web/src/lib/`: `settings-contract.ts`
(pure vocabulary: enums, keys, limits, snapshot/patch types, effect boundary,
defaults and parsers), `system-settings-environment.ts` (the deployment half read
by `settingsEnvironment()`), `settings-headers.ts` (the one extra-header rule),
`system-settings.ts` (stored-row merge, PUT validation, encoding, run overrides —
and the single re-export site for the leaf modules), `system-settings-runtime.ts`
(snapshot/patch assembly), `system-settings-api.ts` (HTTP handlers) and
`system-settings-store.ts` (Prisma); the route files are thin adapters.

### Custom LLM channel card

The settings page also hosts a **Custom LLM Channel** card — a single
operator-supplied OpenAI-compatible endpoint, independent of the snapshot above
and of the proxy credential row. The flow is deliberately linear because saving
it also registers the model with LiteLLM and rewrites the global model override:

1. Type the **API base URL** (`http(s)://host[:port][/path]`; credentials, query
   and fragment are rejected, self-hosted private hosts are fine).
2. **Fetch models** (`POST /api/settings/llm-channel/models`) — the endpoint's
   `/models` listing, 5 s budget server-side.
3. Pick a **model** from the dropdown (a single advertised model is preselected).
4. **Save channel** (`PUT /api/settings/llm-channel`) → the server registers the
   upstream id under an `openai/decepticon-custom-<hash>` alias and points
   `global_model_override` at the alias, which is what the **next terminal
   session** forwards to the CLI. Per-agent overrides still win over it.

The API key is write-only: the field always renders empty, the card shows only
`A key is saved` / `No key saved`, and the server never returns the value. An
unchanged base URL keeps the stored key when the field is left blank; a changed
base URL never reuses it (the server answers `400 { fields: { apiKey } }`, and
the card says so before the request). **Remove channel** clears the base, the key
and the model, and unsets the global override only while it still points at that
channel's alias — an override the operator typed by hand survives.

On success the page adopts the PUT response's `globalModelOverride` into both the
persisted baseline and the visible draft, so a global model id typed by hand
earlier cannot overwrite the freshly registered alias on the next save.

Card code: `clients/web/src/components/settings/llm-channel-card.tsx` with the
browser-side request/validation model in `src/lib/llm-channel-form.ts`, which
shares the base-URL and body rules with the server through the pure
`src/lib/llm-channel.ts`. Labels and messages live in `src/lib/i18n.ts` (en/zh).

---

## API Routes

The dashboard exposes Next.js App Router API routes under `clients/web/src/app/api/`. These proxy requests to LangGraph and serve as the backend for the React frontend. They are not a public API — the surface area may change between versions.
