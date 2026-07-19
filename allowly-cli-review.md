# Allowly CLI Review & Fix Plan

> **2026-07-18 follow-up: all fixes landed and verified.** Commits `3b8cb73`
> (C-1), `795b6fb` (C-2), `bee8c0b` (C-3), `936357a` (C-4), `60c9a52` (C-5),
> `9c9cc1c` (M-1), `3190382` (M-2), `834797b` (M-3), `87ae614` (M-4),
> `ad94b17` (N-1). Each reviewed individually; 15/15 tests (3 new), typecheck
> and build clean, smoke-tested flag guard / `--context` validation / missing
> config / exit code 1. Notable: C-4 initially retried only on `TypeError`, but
> C-5 correctly widened it to include `TimeoutError` DOMExceptions when it
> added the 30s fetch timeouts — the interaction was handled. M-2 and M-4 go
> slightly beyond the plan (object-shape validation; login hint suppressed for
> `check`/`login` commands where it would be wrong advice). N-2/N-3 fixed later the same
> day (`--version`/`-v` reads the version from package.json at runtime; `init`
> on an existing file now repeats the apply next-steps). Nothing from this
> review remains open.

Reviewed: 2026-07-18. Scope: `allowly-cli` (src/config.ts, src/http.ts,
src/setupConfig.ts, src/index.ts, tests, CI workflows), cross-checked against
`allowly-api` (`app/routers/setup.py`, `check.py`, `services/setup_resources.py`)
and `allowly_app` (`backend/app/routers/cli.py` device flow). Sibling review:
`../allowly-api/allwoly-api-review.md`.

Baseline at review time: 12/12 tests pass, `tsc --noEmit` clean.

## Summary

The CLI is appropriately small and boring — hand-rolled arg parsing, no
dependencies, create-only idempotent apply, 0600 config. That's the right
shape. The findings are: one real correctness bug (pagination ignored on the
setup list endpoints, and the policy pre-check is the **only** guard because
the API does not validate policy action names server-side), one flag-precedence
bug in `login`, and a cluster of error-path robustness gaps (non-JSON error
bodies, transient network errors during the login poll, no fetch timeout).
Nothing here blocks a private release; C-1 through C-4 should land before the
public npm publish, since the pitch is "let an agent drive this" and agents hit
error paths harder than humans.

## Fixes, ranked

### C-1. `apply` commands read only the first page of paginated list endpoints

- Where: [src/index.ts:368](src/index.ts:368) (`commandActionsApply`),
  [src/index.ts:394](src/index.ts:394) and [src/index.ts:403](src/index.ts:403)
  (`commandPoliciesApply`).
- Problem: `GET /v1/setup/actions` and `GET /v1/setup/policies` are cursor-
  paginated with `limit` default **and max** 100 (`allowly-api/app/routers/setup.py:245`,
  `_limits.py:32`). The CLI ignores `has_more`/`next_cursor`.
- Failure: workspace with >100 actions → (a) `actions apply` re-POSTs an
  action that exists on page 2 → API 409 `action_already_exists` → apply aborts
  mid-run; (b) `policies apply` falsely reports "references missing actions"
  for real actions beyond page 1 and refuses to apply. The pre-check cannot be
  deleted instead: `create_agent_policy` (`setup_resources.py:386`) does **not**
  validate action names, so the CLI check is the only thing preventing a policy
  that references nonexistent actions.
- Fix: one paging helper, used by both commands.

```ts
// index.ts — add near apiRequest usage
interface Page<T> { items: T[]; next_cursor?: string | null }

async function listAll<T>(config: CliConfig, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiRequest<Page<T>>(
      config, "GET",
      `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
}
```

Then:
- index.ts:368 → `const existingNames = new Set((await listAll<{ name: string }>(config, "/v1/setup/actions")).map(a => a.name));`
- index.ts:394 → same `listAll` for the missing-actions pre-check.
- index.ts:403 → `listAll<{ policy_id?: string }>(config, "/v1/setup/policies")`.
- `CliConfig` import in index.ts (type-only) is the only new import.

### C-2. Explicit `--api-url` on `login` is silently overridden by the server

- Where: [src/index.ts:179](src/index.ts:179).
- Problem: `authorized.api_url ?? apiUrl` — the app backend always returns
  `api_url` (`allowly_app/backend/app/routers/cli.py:135` falls back to
  `https://api.allowly.ai`), so a user-passed `--api-url` never wins. README
  documents the flag as "override the API URL written to the local CLI config".
- Failure: `allowly login --app-url http://localhost:8000 --api-url http://localhost:8787`
  against an app whose `allowly_api_base_url` is set → config written pointing
  at the wrong API; every later command hits the wrong host.
- Fix (flag > server > default):

```ts
// commandLogin
const apiUrlFlag = option(args, "--api-url");
const apiUrl = apiUrlFlag ?? DEFAULT_API_URL;   // line 146, for --setup-token path
...
const configuredApiUrl = apiUrlFlag ?? authorized.api_url ?? DEFAULT_API_URL;  // line 179
```

### C-3. Non-JSON error bodies crash with a raw `SyntaxError`

- Where: [src/http.ts:38](src/http.ts:38) and [src/index.ts:116](src/index.ts:116).
- Problem: `JSON.parse(text)` runs before the `response.ok` check. A Cloudflare
  502/524 HTML page, or any proxy plain-text error, throws
  `Unexpected token '<'...` instead of "Allowly API returned 502".
- Fix: parse the error path defensively; keep the success path strict (a 200
  with a non-JSON body *should* still be an error).

```ts
// http.ts apiRequest, replacing lines 37–45
const text = await response.text();
if (!response.ok) {
  let parsed: ApiErrorBody = {};
  try { parsed = text ? JSON.parse(text) as ApiErrorBody : {}; } catch { /* non-JSON error body */ }
  throw new AllowlyCliError(
    parsed.error?.message ?? `Allowly API returned ${response.status}`,
    response.status,
    parsed.error?.code ?? "error",
  );
}
return (text ? JSON.parse(text) : undefined) as T;
```

Same shape in `requestJson` (index.ts:115–123): try/catch the parse, and when
`!response.ok && response.status !== 202` use the fallback message; on ok/202,
parse strictly.

### C-4. One transient network error aborts the whole login wait

- Where: [src/index.ts:168](src/index.ts:168) (poll loop).
- Problem: the loop can run up to `expires_in` (device-code TTL). A single
  ECONNRESET/DNS blip inside `requestJson` throws `fetch failed` and kills the
  login; the user must redo the browser approval. Real API answers (denied 403,
  expired 401, consumed 409 — verified in `allowly_app/backend/app/routers/cli.py`)
  arrive as `AllowlyCliError` and must still abort.
- Fix:

```ts
let tokenResponse;
try {
  tokenResponse = await requestJson<DeviceTokenResponse | { status: "pending"; interval?: number }>(
    appUrl, "/v1/cli/device/token", { device_code: device.device_code },
  );
} catch (err) {
  if (err instanceof AllowlyCliError) throw err;  // denied/expired/consumed: stop
  continue;  // transient network error: keep polling until the deadline
}
```

### C-5. No fetch timeout anywhere

- Where: [src/http.ts:26](src/http.ts:26), [src/index.ts:110](src/index.ts:110).
- Problem: a hung socket hangs the CLI forever; the login deadline is only
  checked between polls, so it never fires during a hung request.
- Fix: one line per fetch (Node 18+):

```ts
signal: AbortSignal.timeout(30_000),
```

### M-1. `option()` accepts the next flag as a value

- Where: [src/index.ts:95](src/index.ts:95) (and `options()` at 101).
- Problem: `allowly check --authorization-id --action web.search` yields
  `authorizationId === "--action"`, which goes to the API and fails with a
  confusing 404/422 instead of "Missing --authorization-id".
- Fix:

```ts
function option(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}
```

Mirror the same guard in `options()` (line 104: `if (args[i] === name && args[i + 1] && !args[i + 1].startsWith("--"))`).

### M-2. Raw `SyntaxError` for corrupt config and bad `--context`

- Where: [src/config.ts:28](src/config.ts:28), [src/index.ts:492](src/index.ts:492).
- Fix:

```ts
// config.ts readConfig
let parsed: Partial<CliConfig> & { setupToken?: string };
try {
  parsed = JSON.parse(raw);
} catch {
  throw new Error("Allowly CLI config is corrupt. Run `allowly login` again.");
}
```

```ts
// index.ts commandCheck
let context: Record<string, unknown> = {};
if (contextRaw) {
  try { context = JSON.parse(contextRaw) as Record<string, unknown>; }
  catch { throw new Error("--context must be valid JSON"); }
}
```

### M-3. `keys create --write-env` strips blank lines from the user's env file

- Where: [src/index.ts:436](src/index.ts:436).
- Problem: `.filter(Boolean)` drops every empty line, so rewriting
  `.env.local` collapses the user's grouping/formatting.
- Fix:

```ts
const lines = existing.length ? existing.replace(/\r?\n$/, "").split(/\r?\n/) : [];
```

(The trailing-newline strip prevents a phantom empty last line; the length
check keeps the fresh-file case at `[]`.)

### M-4. Expired CLI credential gives a bare 401 with no next step

- Where: [src/index.ts:549](src/index.ts:549) (error handler). `expiresAt` is
  stored but never used; server 401s pass through verbatim.
- Fix (one line in the catch):

```ts
if (err.status === 401) console.error("CLI credential may be expired. Run `allowly login`.");
```

## Nits (fix opportunistically, none blocking)

- N-1 [src/index.ts:544](src/index.ts:544): `[action, fileOrArg, ...rest].filter(Boolean)`
  → `argv.slice(2)` is equivalent and doesn't eat empty-string args.
- N-2: no `--version` flag; `allowly --version` prints "Unknown command" plus
  the full usage. Inject the version at build time (`tsup --define`) or read
  package.json via `createRequire`; skip until someone asks.
- N-3 [src/index.ts:357](src/index.ts:357): `init` on existing file prints
  "already exists" and exits 0 with no next-steps hint. Fine for idempotency;
  add `printApplyNextSteps(file)` there if it bothers anyone.

## Checked and fine (evidence, not vibes)

- **Device flow terminal states**: denied → 403, expired → 401, consumed → 409,
  issuing → 409 (`allowly_app/backend/app/routers/cli.py:63-95`); all are
  non-202 non-ok, so the CLI throws instead of looping or writing a corrupt
  config. Pending → 202 `{status, interval}` is handled, and
  `Math.max(1, ...)` floors the poll interval.
- **Action-level `requires_deny` is seed-only, not a dropped field**: the API's
  `ActionCreate` (`setup.py:50`) has no `requires_deny`; deny is policy-level
  (`requires_deny_for`), which `commandPoliciesApply` does send. The seed field
  exists only to generate `requires_deny_for` in `generatedPolicy`.
- **`/v1/check` body shape matches the API**: `authorization_id`,
  `actions: list[str]` (≤25, no duplicates), optional `resource`/`session_id`,
  `context` object (`check.py:160`); `?wait=true` is a real server feature.
- **Secret hygiene**: config dir 0700, file 0600 with post-write chmod (covers
  pre-existing files); env files written 0600; runtime key printed only when
  not written to disk; login token never echoed.
- **Idempotent create-only apply** is intentional and commented; no destructive
  paths in the CLI at all.
- **Rate-limit fit**: poll interval from the server vs `device/token` at
  60/min — no self-inflicted 429.
- **`openBrowser`** uses the correct `cmd /c start "" <url>` on win32 and
  swallows spawn errors (URL is printed regardless).
- **CI/publish workflows**: read-only permissions, manual dispatch with
  `dry_run` defaulting to `"true"`, single concurrency group. Fine.
- **Ponytail check**: no dependencies, no abstractions to delete. The two
  near-misses (`options()` multi-flag helper, `--env-file`/`--env-output`
  aliases) are small and already earn their keep.

## Suggested landing order

1. C-3 + C-5 (http.ts error path + timeouts) — smallest diff, biggest
   robustness gain, shared by every command.
2. C-1 (`listAll` pagination) + a vitest case with a stubbed two-page fetch.
3. C-2 (flag precedence) — one-line, plus a README sentence stays true.
4. C-4 (poll resilience).
5. M-1/M-2/M-4 batched as "error message polish"; M-3 with the next
   `keys create` touch.
