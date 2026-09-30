import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  DEFAULT_APP_URL,
  readConfig,
  removeConfig,
  removeConfigIfCredentialMatches,
  writeConfig,
} from "./config.js";

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
    appUrl: "http://localhost:3000/",
    accessToken: "allowly_t1_s001_cli_secret",
    expiresAt: "2026-07-22T00:00:00Z",
    workspaceId: "ws_test",
    workspaceName: "Test",
  }, path);

  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved).toEqual({
    apiUrl: "https://api.allowly.ai",
    appUrl: "http://localhost:3000",
    accessToken: "allowly_t1_s001_cli_secret",
    expiresAt: "2026-07-22T00:00:00Z",
    workspaceId: "ws_test",
    workspaceName: "Test",
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(readConfig(path)).resolves.toEqual({
    apiUrl: "https://api.allowly.ai",
    appUrl: "http://localhost:3000",
    accessToken: "allowly_t1_s001_cli_secret",
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
    JSON.stringify({ apiUrl: "https://api.allowly.ai", setupToken: "allowly_t1_s001_setup_secret" }),
    { mode: 0o600 },
  );

  await expect(readConfig(path)).resolves.toEqual({
    apiUrl: "https://api.allowly.ai",
    appUrl: DEFAULT_APP_URL,
    accessToken: "allowly_t1_s001_setup_secret",
    expiresAt: undefined,
    workspaceId: undefined,
    workspaceName: undefined,
  });
});

test("dashboard URL is optional and stays separate from the app API URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-dashboard-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  await writeConfig({
    apiUrl: "http://127.0.0.1:8085",
    appUrl: "http://127.0.0.1:8480",
    dashboardUrl: "https://localhost:8843",
    accessToken: "test-setup-secret",
  }, path);

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    apiUrl: "http://127.0.0.1:8085",
    appUrl: "http://127.0.0.1:8480",
    dashboardUrl: "https://localhost:8843",
    accessToken: "test-setup-secret",
  });
  await expect(readConfig(path)).resolves.toMatchObject({
    appUrl: "http://127.0.0.1:8480",
    dashboardUrl: "https://localhost:8843",
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("readConfig explains corrupt JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, "{not json", { mode: 0o600 });

  await expect(readConfig(path)).rejects.toThrow("Allowly CLI config is corrupt. Run `allowly login` again.");
});

test("removeConfig deletes local config and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-"));
  dirs.push(dir);
  const path = join(dir, "config.json");

  await writeConfig({ apiUrl: "https://api.allowly.ai", accessToken: "setup-token" }, path);

  await expect(removeConfig(path)).resolves.toBe(true);
  await expect(readConfig(path)).rejects.toThrow("Allowly CLI is not configured");
  await expect(removeConfig(path)).resolves.toBe(false);
});

test("conditional removal preserves a newer credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowly-cli-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  await writeConfig({ apiUrl: "https://api.allowly.ai", accessToken: "new-token" }, path);

  await expect(removeConfigIfCredentialMatches("old-token", path)).resolves.toBe(false);
  await expect(readConfig(path)).resolves.toMatchObject({ accessToken: "new-token" });
});
