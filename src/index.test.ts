import { createPublicKey, verify } from "node:crypto";
import fsPromises, { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { writeConfig } from "./config.js";
import { createNativeEnrollment, type NativeAgentCredential } from "./nativeIdentity.js";

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

test("agent enroll stores the private key locally and registers only the public key", async () => {
  const configFile = await configureCli();
  const credentialFile = join(configFile, "..", "agent.json");
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/setup/status")) {
      return new Response(JSON.stringify({ workspace_id: "ws_123" }));
    }
    expect(String(url)).toBe("https://api.allowly.test/v1/setup/agent-credentials");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer setup-secret", "Content-Type": "application/json" });
    const body = JSON.parse(String(init?.body)) as {
      agent_id: string; public_key: string; possession_proof: string;
    };
    expect(body.agent_id).toBe("agent_123");
    expect(body.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.possession_proof).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verify(
      null,
      Buffer.from(`allowly-agent-enroll-v1\nws_123\nagent_123\n${body.public_key}`),
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: body.public_key }, format: "jwk" }),
      Buffer.from(body.possession_proof, "base64url"),
    )).toBe(true);
    expect(String(init?.body)).not.toContain("private_key_jwk");
    return new Response(JSON.stringify({
      key_id: "key_123", binding_id: "bind_123", agent_id: "agent_123", status: "active",
    }), { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent", "enroll", "agent_123", "--out", credentialFile];

  await import("./index.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("Agent agent_123 enrolled")));

  const credential = JSON.parse(await readFile(credentialFile, "utf8")) as Record<string, unknown>;
  expect(credential).toMatchObject({
    version: 1, provider: "allowly", workspace_id: "ws_123", agent_id: "agent_123",
    key_id: "key_123", binding_id: "bind_123",
  });
  expect(credential.private_key_jwk).toHaveProperty("d");
  expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
  expect(log.mock.calls.flat().join(" ")).not.toContain(String((credential.private_key_jwk as { d: string }).d));
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  [[], ["key_one", "key_two"]],
  [["--key-id", "key_two"], ["key_two"]],
])("agent remove revokes only the selected active credentials (%j)", async (extra, expected) => {
  await configureCli();
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") {
      expect(String(url)).toBe("https://api.allowly.test/v1/setup/agent-credentials?agent_id=agent_123");
      return new Response(JSON.stringify({ agent_id: "agent_123", credentials: [
        { key_id: "key_one", status: "active" }, { key_id: "key_two", status: "active" },
        { key_id: "key_old", status: "revoked" },
      ] }));
    }
    expect(init?.method).toBe("DELETE");
    expect(init?.headers).toEqual({ Authorization: "Bearer setup-secret" });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent", "remove", "agent_123", "--yes", ...extra];
  await import("./index.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("Local credential files were kept.")));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => String(url))).toEqual(
    expected.map((id) => `https://api.allowly.test/v1/setup/agent-credentials/${id}`),
  );
});

test.each([
  [[], "Confirmation required"],
  [["--yes", "--key-id", "other_agent_key"], "does not belong to this agent"],
])("agent remove does not revoke without confirmation or for another agent's key (%j)", async (extra, message) => {
  await configureCli();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ agent_id: "agent_123", credentials: [
    { key_id: "key_one", status: "active" },
  ] })));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent", "remove", "agent_123", ...extra];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(message)));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
});

test("agent remove reports completed revocations before stopping on a server failure", async () => {
  const configFile = await configureCli();
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(JSON.stringify({ agent_id: "agent_123", credentials: [
      { key_id: "key_one", status: "active" }, { key_id: "key_two", status: "active" },
      { key_id: "key_three", status: "active" },
    ] }));
    if (String(url).endsWith("key_two")) return new Response(JSON.stringify({ error: { code: "unavailable", message: "Try again" } }), { status: 503 });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent", "remove", "agent_123", "--yes"];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Try again")));
  expect(log).toHaveBeenCalledWith("Revoked credential key_one.");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await readFile(configFile, "utf8")).toContain("setup-secret");
});

test("check signs a native agent token from a local credential", async () => {
  await configureCli();
  vi.stubEnv("ALLOWLY_API_KEY", "runtime-secret");
  const credentialDir = await mkdtemp(join(tmpdir(), "allowly-cli-agent-"));
  tempDirs.push(credentialDir);
  const credentialFile = join(credentialDir, "agent.json");
  const created = createNativeEnrollment("ws_123", "agent_123");
  const credential: NativeAgentCredential = {
    version: 1,
    provider: "allowly",
    workspace_id: "ws_123",
    agent_id: "agent_123",
    binding_id: "bind_123",
    key_id: "key_123",
    private_key_jwk: created.privateKeyJwk,
  };
  await fsPromises.writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string>)["X-Allowly-Agent-Token"];
    const [encodedHeader, encodedClaims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({
      alg: "EdDSA", typ: "JWT", kid: "key_123",
    });
    expect(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"))).toMatchObject({
      iss: "allowly-agent", aud: "ws_123", sub: "agent_123", bid: "bind_123",
    });
    expect(verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: created.publicKey }, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )).toBe(true);
    return new Response(JSON.stringify({ decision: "allow" }));
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [
    process.execPath, "allowly", "check", "--authorization-id", "auth_123",
    "--action", "mail.send", "--agent-credential", credentialFile,
  ];

  await import("./index.js");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
});
