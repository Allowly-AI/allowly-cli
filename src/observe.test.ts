import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const dirs: string[] = [];
afterEach(async () => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "allowly-observe-cli-")); dirs.push(directory);
  vi.stubEnv("ALLOWLY_CONFIG_DIR", directory);
  vi.stubEnv("ALLOWLY_API_KEY", "test-runtime-key");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { directory, log, error };
}
const event = { event_id: "operation:1", agent_id: "agent_demo", action: "email.send",
  policy_ref: { policy_id: "published", policy_version: 1, definition_sha256: "a".repeat(64) },
  occurred_at: "2026-10-18T20:00:00Z", reported_execution: "sent", sources: { body: "Fictional capture" } };
const status = { event_id: event.event_id, agent_id: event.agent_id, action: event.action, policy_ref: event.policy_ref,
  reported_execution: "sent", mode: "observe", intervention: "none", processing_status: "pending", assessment_status: "not_assessed",
  signing_status: "unavailable", observed_action_id: null, assessment_id: null, dashboard_url: null, last_error: null };

test("submit works without login using the actual SDK and never calls setup", async () => {
  const { directory, log, error } = await environment();
  const file = join(directory, "event.json"); await writeFile(file, JSON.stringify(event));
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://runtime.test/v1/observe/events");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-runtime-key");
    expect(JSON.parse(String(init?.body))).toEqual(event);
    return new Response(JSON.stringify(status), { status: 202 });
  }); vi.stubGlobal("fetch", fetch);
  process.argv = [process.execPath, "allowly", "observe", "submit", file, "--api-url", "https://runtime.test"];
  await import("./index.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ eventId: event.event_id, assessmentStatus: "not_assessed", intervention: "none" });
  expect(error).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});

test("get defaults to public API without login and encodes the event ID", async () => {
  const { log, error } = await environment();
  const fetch = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://api.allowly.ai/v1/observe/events/operation%3A1");
    return new Response(JSON.stringify(status));
  }); vi.stubGlobal("fetch", fetch);
  process.argv = [process.execPath, "allowly", "observe", "get", "operation:1"];
  await import("./index.js"); await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(error).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});

test("existing corrupt config remains an error even with an explicit runtime key", async () => {
  const { directory, error } = await environment(); await writeFile(join(directory, "config.json"), "not-json");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  process.argv = [process.execPath, "allowly", "observe", "get", "operation:1", "--api-key", "test-runtime-key"];
  await import("./index.js"); await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("config is corrupt")));
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["extra", "prediction", "missing_report"])("invalid %s capture never reaches the API", async kind => {
  const { directory, error } = await environment(); const invalid: Record<string, unknown> = structuredClone(event);
  if (kind === "extra") invalid.langfuse_secret_key = "test-secret";
  else if (kind === "prediction") invalid.sources = { body: true };
  else delete invalid.reported_execution;
  const file = join(directory, "event.json"); await writeFile(file, JSON.stringify(invalid));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  process.argv = [process.execPath, "allowly", "observe", "submit", file];
  await import("./index.js"); await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(fetch).not.toHaveBeenCalled(); expect(String(error.mock.calls[0][0])).not.toContain("test-secret");
});

test.each([200, 409, 503])("submission HTTP%s error is visible and never automatically retried", async code => {
  const { directory, error, log } = await environment(); const file = join(directory, "event.json"); await writeFile(file, JSON.stringify(event));
  const fetch = vi.fn(async () => new Response(JSON.stringify(code === 200 ? status : { error: { code: "event_conflict", message: "Different content" } }), { status: code }));
  vi.stubGlobal("fetch", fetch); process.argv = [process.execPath, "allowly", "observe", "submit", file];
  await import("./index.js"); await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
});

test("existing check command also accepts runtime credentials without login", async () => {
  const { log, error } = await environment();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ request_id: "test", results: {} })));
  vi.stubGlobal("fetch", fetch);
  process.argv = [process.execPath, "allowly", "check", "--authorization-id", "auth_test", "--action", "email.send"];
  await import("./index.js"); await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(error).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});
