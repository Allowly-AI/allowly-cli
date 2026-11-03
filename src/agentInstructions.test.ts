import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeConfig } from "./config.js";
import { apiRequest } from "./http.js";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const directories: string[] = [];
const GUIDANCE = "# Support agent\nUse ticket.reply with real facts. Policy edition: 2.\n";

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function configure(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "allowly-instructions-"));
  directories.push(dir);
  vi.stubEnv("ALLOWLY_CONFIG_DIR", dir);
  vi.stubEnv("ALLOWLY_API_KEY", "runtime-secret");
  vi.stubEnv("ALLOWLY_AGENT_TOKEN", "");
  await writeConfig({ apiUrl: "https://api.allowly.test", accessToken: "setup-secret" });
  return dir;
}

test("agent-instructions writes exact plain text using runtime credentials and encoded names", async () => {
  const dir = await configure();
  const envFile = join(dir, ".env.local");
  await writeFile(envFile, "CUSTOM_RUNTIME_KEY=file-runtime-secret\n");
  const name = "Support /?&=# + café 🧭";
  const fetch = vi.fn().mockResolvedValue(new Response(GUIDANCE, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  vi.stubGlobal("fetch", fetch);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", "--agent-name", name,
    "--runtime-env", envFile, "--var", "CUSTOM_RUNTIME_KEY", "--api-url", "https://selected.allowly.test/"];
  await import("./index.js");
  await vi.waitFor(() => expect(stdout).toHaveBeenCalledWith(GUIDANCE));
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fetch.mock.calls[0];
  expect(new URL(url).origin).toBe("https://selected.allowly.test");
  expect(new URL(url).pathname).toBe("/v1/agent-instructions");
  expect([...new URL(url).searchParams.entries()]).toEqual([["agent_name", name]]);
  expect(new URL(url).hash).toBe("");
  expect(request).toMatchObject({ method: "GET", redirect: "manual", headers: {
    Authorization: "Bearer file-runtime-secret", Accept: "text/plain",
  } });
  expect(request.headers["X-Allowly-Agent-Token"]).toBeUndefined();
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(error).not.toHaveBeenCalled();
});

test("agent-instructions never borrows the saved login credential", async () => {
  await configure();
  vi.stubEnv("ALLOWLY_API_KEY", "");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", "--agent-name", "Support agent"];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Missing runtime API key")));
  expect(fetch).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test.each([
  [], ["--agent-name"], ["--agent-name", " "], ["--agent-name", " padded"],
  ["--agent-name", "padded "], ["--agent-name", "a\0b"], ["--agent-name", "a".repeat(129)],
  ["--agent-name", "Support", "--agent-name", "Other"], ["--agent-name", "Support", "--unknown", "x"],
].map(args => ({ args })))("agent-instructions rejects missing or invalid arguments: $args", async ({ args }) => {
  await configure();
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", ...args];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(fetch).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test("agent-instructions rejects a configured identity token before HTTP", async () => {
  await configure();
  vi.stubEnv("ALLOWLY_AGENT_TOKEN", "identity-secret");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", "--agent-name", "Support agent"];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith("name-routed instructions cannot use configured agent identity"));
  expect(fetch).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test.each([
  [200, "application/json", '{"instructions":"text"}'], [200, "text/html", "<html>error</html>"],
  [200, "", "guidance"], [200, "text/plain", " \n"], [200, "text/plain", '{"error":"proxy error"}'],
  [200, "text/plain", "<html>error</html>"], [200, "text/plain", "echo runtime-secret"],
  [201, "text/plain", "guidance"], [204, "", null],
])("agent-instructions fails without stdout on invalid success %s %s %s", async (status, mime, body) => {
  await configure();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": mime } })));
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", "--agent-name", "Support agent"];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(error.mock.calls.flat().join(" ")).not.toContain("runtime-secret");
  expect(stdout).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test.each([302, 401, 404, 409, 429, 503])("agent-instructions maps HTTP %s errors without redirect or fallback", async status => {
  await configure();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
    code: "named_agent_not_found", message: "runtime-secret invalid",
  } }), { status, headers: { Location: "https://other.example/" } }));
  vi.stubGlobal("fetch", fetch);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "agent-instructions", "--agent-name", "Support agent"];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Allowly API error (named_agent_not_found): [REDACTED] invalid"));
  expect(stdout).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
});

test("text transport rejects bad UTF-8, followed redirects, and transport errors", async () => {
  const redirected = new Response(GUIDANCE, { headers: { "Content-Type": "text/plain" } });
  Object.defineProperty(redirected, "redirected", { value: true });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "text/plain" } }))
    .mockResolvedValueOnce(redirected).mockRejectedValueOnce(new Error("runtime-secret offline"));
  vi.stubGlobal("fetch", fetch);
  const request = () => apiRequest<string>({ apiUrl: "https://api.example.com", accessToken: "runtime-secret" },
    "GET", "/v1/agent-instructions?agent_name=Support", undefined, 10, { Accept: "text/plain" }, "text");
  await expect(request()).rejects.toThrow("UTF-8");
  await expect(request()).rejects.toThrow("Redirected");
  await expect(request()).rejects.toThrow("Allowly request failed");
  await expect(apiRequest({ apiUrl: "ftp://other.example", accessToken: "runtime-secret" },
    "GET", "/v1/agent-instructions", undefined, 10, {}, "text")).rejects.toThrow("HTTP or HTTPS");
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("text transport stops on its timeout", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(signal?.reason));
  })));
  await expect(apiRequest({ apiUrl: "https://api.example.com", accessToken: "runtime-secret" },
    "GET", "/v1/agent-instructions", undefined, 1, {}, "text")).rejects.toThrow("Allowly request failed");
  expect(signal?.aborted).toBe(true);
});
