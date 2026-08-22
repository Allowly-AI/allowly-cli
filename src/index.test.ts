import { afterEach, expect, test, vi } from "vitest";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

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
