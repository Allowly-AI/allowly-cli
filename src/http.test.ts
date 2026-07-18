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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })));

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
});
