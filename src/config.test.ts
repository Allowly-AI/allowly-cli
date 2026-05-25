import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { readConfig, writeConfig } from "./config.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("writeConfig stores CLI access token with owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-"));
  dirs.push(dir);
  const path = join(dir, "config.json");

  await writeConfig({
    apiUrl: "https://api.allowly.ai/",
    accessToken: "allowly_cli_secret",
    expiresAt: "2026-07-22T00:00:00Z",
    workspaceId: "ws_test",
    workspaceName: "Test",
  }, path);

  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved).toEqual({
    apiUrl: "https://api.allowly.ai",
    accessToken: "allowly_cli_secret",
    expiresAt: "2026-07-22T00:00:00Z",
    workspaceId: "ws_test",
    workspaceName: "Test",
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(readConfig(path)).resolves.toEqual({
    apiUrl: "https://api.allowly.ai",
    accessToken: "allowly_cli_secret",
    expiresAt: "2026-07-22T00:00:00Z",
    workspaceId: "ws_test",
    workspaceName: "Test",
  });
});

test("readConfig still accepts old manual setup-token config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-"));
  dirs.push(dir);
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({ apiUrl: "https://api.allowly.ai", setupToken: "allowly_setup_secret" }),
    { mode: 0o600 },
  );

  await expect(readConfig(path)).resolves.toEqual({
    apiUrl: "https://api.allowly.ai",
    accessToken: "allowly_setup_secret",
    expiresAt: undefined,
    workspaceId: undefined,
    workspaceName: undefined,
  });
});
