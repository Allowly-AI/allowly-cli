import { afterEach, expect, test, vi } from "vitest";

import { apiRequest, listAll } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("listAll follows setup cursors", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ name: "first" }], next_cursor: "next cursor" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ name: "second" }], next_cursor: null })));
  vi.stubGlobal("fetch", fetch);

  await expect(listAll<{ name: string }>(
    { apiUrl: "https://api.allowly.ai", accessToken: "token" },
    "/v1/setup/actions",
  )).resolves.toEqual([{ name: "first" }, { name: "second" }]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.allowly.ai/v1/setup/actions?limit=100",
    "https://api.allowly.ai/v1/setup/actions?limit=100&cursor=next%20cursor",
  ]);
});

test("apiRequest reports non-JSON API errors by status", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
  vi.stubGlobal("fetch", fetch);

  const request = apiRequest(
    { apiUrl: "https://api.allowly.ai", accessToken: "token" },
    "GET",
    "/v1/setup/status",
  );
  await expect(request).rejects.toMatchObject({
    message: "Allowly API returned 502",
    status: 502,
    code: "error",
  });
  expect((fetch.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
});

test("apiRequest redacts an agent token echoed by an error response", async () => {
  const token = "sensitive-agent-token";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code: `agent_token_invalid_${token}`, message: `invalid ${token} runtime-secret` },
  }), { status: 401 })));

  await expect(apiRequest(
    { apiUrl: "https://api.allowly.ai", accessToken: "runtime-secret" },
    "POST",
    "/v1/check",
    {},
    30_000,
    { "X-Allowly-Agent-Token": token },
  )).rejects.toMatchObject({
    code: "agent_token_invalid_[REDACTED]",
    message: "invalid [REDACTED] [REDACTED]",
  });
});

test.each([
  "setup-secret-example", '{"access_token":"setup-secret-example"',
])("apiRequest hides malformed successful response bodies: %s", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 201 })));

  await expect(apiRequest(
    { apiUrl: "https://app.allowly.ai", accessToken: "recovery-proof" },
    "POST",
    "/v1/agent-trials",
  )).rejects.toMatchObject({ message: "Allowly API returned invalid JSON", status: 201 });
});
