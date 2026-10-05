import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeConfig } from "./config.js";
import { trialCommand } from "./trial.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "allowly-trial-"));
  directories.push(path);
  vi.stubEnv("ALLOWLY_CONFIG_DIR", path);
  return path;
}

const bootstrap = {
  trial_id: "trial_123", account_id: "acct_123", workspace_id: "ws_123", workspace_name: "My agent",
  api_url: "https://api.allowly.test", access_token: "setup-secret", token_type: "Bearer",
  expires_at: "2026-10-12T00:00:00Z", claim_url: "https://app.allowly.ai/claim/trial_123#token=" + "c".repeat(43),
  status_url: "https://app.allowly.ai/v1/agent-trials/trial_123", decisions_included: 1000, status: "unclaimed",
};

test("bootstrap saves immutable recovery proof before sending, retries the same trial, and hides secrets", async () => {
  const path = await directory();
  const sent: Array<{ headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init.method === "GET") return new Response(JSON.stringify({ status: "unclaimed", expired: false }));
    expect(url).toBe("https://app.allowly.ai/v1/agent-trials");
    const saved = JSON.parse(await readFile(join(path, "trial.json"), "utf8"));
    expect((await stat(join(path, "trial.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(init.body)).toEqual({ name: saved.name, recovery_secret: saved.recoverySecret });
    expect(init.headers["Idempotency-Key"]).toBe(saved.idempotencyKey);
    expect(saved.recoverySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(init.redirect).toBe("manual");
    sent.push({ headers: init.headers, body: init.body });
    if (sent.length === 1) throw new TypeError("network interrupted");
    return new Response(JSON.stringify(bootstrap), { status: 201 });
  }));
  await expect(trialCommand("create", { name: "My agent" })).rejects.toThrow("network interrupted");
  const result = await trialCommand("create", { name: "My agent" });
  expect(sent[0]).toEqual(sent[1]);
  const state = JSON.parse(await readFile(join(path, "trial.json"), "utf8"));
  const output = JSON.stringify(result);
  for (const secret of [state.recoverySecret, bootstrap.access_token, bootstrap.claim_url]) expect(output).not.toContain(secret);
  expect(result).toMatchObject({ workspace_id: "ws_123", claim_file: join(path, "trial-claim-url.txt") });
  expect(JSON.parse(await readFile(join(path, "config.json"), "utf8"))).toMatchObject({
    workspaceId: "ws_123", accessToken: "setup-secret", apiUrl: "https://api.allowly.test",
  });
  expect(await readFile(join(path, "trial-claim-url.txt"), "utf8")).toBe(bootstrap.claim_url + "\n");
  for (const file of ["trial.json", "config.json", "trial-claim-url.txt"]) expect((await stat(join(path, file))).mode & 0o777).toBe(0o600);
  await unlink(join(path, "config.json"));
  await unlink(join(path, "trial-claim-url.txt"));
  await trialCommand("create", {});
  expect(sent).toHaveLength(2);
  expect(await readFile(join(path, "trial-claim-url.txt"), "utf8")).toContain("#token=");
  await expect(trialCommand("create", { name: "Different" })).rejects.toThrow("saved trial name");
});

test("status selects metadata only, and recovery rotates secrets while preserving workspace IDs", async () => {
  const path = await directory();
  const fetch = vi.fn(async (_url, init) => new Response(JSON.stringify(init.method === "GET"
    ? { ...bootstrap, decisions_used: 1000, decisions_remaining: 0, expired: false }
    : bootstrap)));
  vi.stubGlobal("fetch", fetch);
  await trialCommand("create", {});
  const result = await trialCommand("status", {});
  expect(result).toMatchObject({ decisions_used: 1000, decisions_remaining: 0 });
  expect(JSON.stringify(result)).not.toContain("setup-secret");
  expect(JSON.stringify(result)).not.toContain("#token");
  fetch.mockImplementation(async (url, init) => {
    expect(url).toBe(bootstrap.status_url + "/recover");
    expect(init.body).toBeUndefined();
    return new Response(JSON.stringify({ ...bootstrap, access_token: "rotated-secret",
      claim_url: bootstrap.claim_url.replace("c".repeat(43), "r".repeat(43)) }));
  });
  await trialCommand("recover", {});
  expect(await readFile(join(path, "config.json"), "utf8")).toContain("rotated-secret");
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ...bootstrap, workspace_id: "ws_other" })));
  await expect(trialCommand("recover", {})).rejects.toThrow("does not match");
  expect(await readFile(join(path, "config.json"), "utf8")).toContain("rotated-secret");
});

test("trial does not replace a human workspace or send recovery proof to an unsafe origin", async () => {
  await directory();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(trialCommand("create", { appUrl: "http://remote.test" })).rejects.toThrow("HTTPS");
  await writeConfig({ apiUrl: "https://api.allowly.test", accessToken: "human-secret", workspaceId: "ws_human" });
  await expect(trialCommand("create", {})).rejects.toThrow("already configured");
  expect(fetch).not.toHaveBeenCalled();
});

test("bootstrap errors cannot echo the recovery proof", async () => {
  const path = await directory();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const secret = JSON.parse(init.body).recovery_secret;
    return new Response(JSON.stringify({ error: { code: "bad_" + secret, message: "Rejected " + secret } }), { status: 401 });
  }));
  let error: unknown;
  try { await trialCommand("create", {}); } catch (err) { error = err; }
  const state = JSON.parse(await readFile(join(path, "trial.json"), "utf8"));
  expect(String(error)).not.toContain(state.recoverySecret);
  expect(String(error)).toContain("[REDACTED]");
});

test("a concurrent trial command cannot rotate credentials", async () => {
  const path = await directory();
  await writeFile(join(path, "trial.json.lock"), String(process.pid));
  vi.stubGlobal("fetch", vi.fn());
  await expect(trialCommand("create", {})).rejects.toThrow("Another trial command");
  expect(fetch).not.toHaveBeenCalled();
});

test("completed claim or expiry cannot restore old credentials through cached bootstrap", async () => {
  const path = await directory();
  const fetch = vi.fn(async () => new Response(JSON.stringify(bootstrap)));
  vi.stubGlobal("fetch", fetch);
  await trialCommand("create", {});
  await unlink(join(path, "config.json"));
  fetch.mockImplementation(async () => new Response(JSON.stringify({ error: {
    code: "trial_proof_invalid", message: "Trial proof is no longer valid" } }), { status: 403 }));
  await expect(trialCommand("create", {})).rejects.toThrow("Trial proof");
  await expect(readFile(join(path, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  fetch.mockImplementation(async () => new Response(JSON.stringify({ status: "unclaimed", expired: true })));
  await expect(trialCommand("create", {})).rejects.toThrow("access has ended");
  await expect(readFile(join(path, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a human login completed during bootstrap is kept while the response remains recoverable", async () => {
  const path = await directory();
  vi.stubGlobal("fetch", vi.fn(async () => {
    await writeConfig({ apiUrl: "https://api.allowly.test", accessToken: "human-secret", workspaceId: "ws_human" });
    return new Response(JSON.stringify(bootstrap));
  }));
  await expect(trialCommand("create", {})).rejects.toThrow("another workspace");
  expect(await readFile(join(path, "config.json"), "utf8")).toContain("human-secret");
  expect(JSON.parse(await readFile(join(path, "trial.json"), "utf8")).bootstrap.workspace_id).toBe("ws_123");
});

test("corrupt recovery state cannot expose secret JSON in a parser error", async () => {
  const path = await directory();
  await writeFile(join(path, "trial.json"), '{"recoverySecret":"never-print-this-secret"BROKEN}');
  await expect(trialCommand("create", {})).rejects.toThrow("Saved trial state is corrupt.");
});
