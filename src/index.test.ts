import fsPromises, { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { writeConfig } from "./config.js";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const tempDirs: string[] = [];

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function configureCli(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "allowly-cli-logout-"));
  tempDirs.push(configDir);
  vi.stubEnv("ALLOWLY_CONFIG_DIR", configDir);
  await writeConfig({ apiUrl: "https://api.allowly.test", accessToken: "setup-secret" });
  return join(configDir, "config.json");
}

test.each([
  ["login", ["login", "--help"]],
  ["keys create", ["keys", "create", "--help"]],
])("%s help prints usage without starting the command", async (_command, args) => {
  const fetch = vi.fn(() => { throw new Error("unexpected network access"); });
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", ...args];

  await import("./index.js");

  expect(fetch).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Allowly CLI"));
});

test("logout revokes the server credential before removing local config", async () => {
  const configFile = await configureCli();
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(await readFile(configFile, "utf8")).toContain("setup-secret");
    expect(String(url)).toBe("https://api.allowly.test/v1/setup/credential");
    expect(init?.method).toBe("DELETE");
    expect(init?.headers).toEqual({ Authorization: "Bearer setup-secret" });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "logout"];

  await import("./index.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Logged out and revoked the Allowly CLI credential."));

  await expect(readFile(configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("logout does not unlink a concurrent login written after credential comparison", async () => {
  const configFile = await configureCli();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "logout"];

  const unlink = fsPromises.unlink;
  let wroteConcurrentLogin = false;
  fsPromises.unlink = async (path) => {
    if (!wroteConcurrentLogin) {
      wroteConcurrentLogin = true;
      await writeConfig({ apiUrl: "https://api.allowly.test", accessToken: "new-login-secret" }, configFile);
    }
    return unlink(path);
  };
  syncBuiltinESMExports();

  try {
    await import("./index.js");
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
      "Logged out and revoked the Allowly CLI credential.",
    ));
  } finally {
    fsPromises.unlink = unlink;
    syncBuiltinESMExports();
  }

  expect(wroteConcurrentLogin).toBe(true);
  expect(await readFile(configFile, "utf8")).toContain("new-login-secret");
});

test("logout removes stale local config when the server returns 401", async () => {
  const configFile = await configureCli();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ error: { code: "invalid_api_key", message: "Credential expired" } }),
    { status: 401 },
  )));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "logout"];

  await import("./index.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
    "Removed stale local Allowly CLI config; the server credential was already invalid or expired.",
  ));

  await expect(readFile(configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

const logoutFailures: Array<[string, () => Promise<Response>]> = [
  ["server failure", async () => new Response(
    JSON.stringify({ error: { code: "unavailable", message: "Try again later" } }),
    { status: 503 },
  )],
  ["network failure", async () => { throw new TypeError("network unavailable"); }],
];

test.each(logoutFailures)("logout keeps local config after %s", async (_failure, response) => {
  const configFile = await configureCli();
  vi.stubGlobal("fetch", vi.fn(response));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "logout"];

  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Local login was kept")));

  expect(await readFile(configFile, "utf8")).toContain("setup-secret");
  expect(error).toHaveBeenCalledWith(expect.stringContaining("retry `allowly logout`"));
  expect(process.exitCode).toBe(1);
});

test("check sends the agent token in a header and the client timestamp in the body", async () => {
  await configureCli();
  const runtimeEnv = join(await mkdtemp(join(tmpdir(), "allowly-cli-runtime-")), ".env");
  tempDirs.push(runtimeEnv.slice(0, runtimeEnv.lastIndexOf("/")));
  await fsPromises.writeFile(
    runtimeEnv,
    "ALLOWLY_API_KEY=runtime-secret\nALLOWLY_AGENT_TOKEN=agent-secret\n",
    { mode: 0o600 },
  );
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toEqual({
      Authorization: "Bearer runtime-secret",
      "Content-Type": "application/json",
      "X-Allowly-Agent-Token": "agent-secret",
    });
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({
      authorization_id: "auth_123",
      actions: ["mail.send"],
      client_timestamp: "2026-09-24T18:00:00-07:00",
      context: {},
    });
    return new Response(JSON.stringify({ decision: "allow" }));
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [
    process.execPath,
    "allowly",
    "check",
    "--authorization-id",
    "auth_123",
    "--action",
    "mail.send",
    "--client-timestamp",
    "2026-09-24T18:00:00-07:00",
    "--runtime-env",
    runtimeEnv,
  ];

  await import("./index.js");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.allowly.test/v1/check");
});

test("check rejects a client timestamp without a timezone before sending", async () => {
  await configureCli();
  vi.stubEnv("ALLOWLY_API_KEY", "runtime-secret");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [
    process.execPath,
    "allowly",
    "check",
    "--authorization-id",
    "auth_123",
    "--action",
    "mail.send",
    "--client-timestamp",
    "2026-09-24T18:00:00",
  ];

  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
    "--client-timestamp must be a valid timestamp with a timezone",
  ));

  expect(fetch).not.toHaveBeenCalled();
});
