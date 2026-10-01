import { createECDH, createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { setupWitness, witnessKeyFingerprint, witnessTarget } from "./witnessSetup.js";

const previousConfigDir = process.env.ALLOWLY_CONFIG_DIR;
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousConfigDir === undefined) delete process.env.ALLOWLY_CONFIG_DIR;
  else process.env.ALLOWLY_CONFIG_DIR = previousConfigDir;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "allowly-witness-setup-"));
  directories.push(directory);
  process.env.ALLOWLY_CONFIG_DIR = directory;
  const helper = join(directory, "local-helper");
  await writeFile(helper, "#!/bin/sh\nexit 0\n");
  await chmod(helper, 0o700);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = { alg: 2, data: [...ecdh.getPublicKey(undefined, "compressed")] };
  const fingerprint = witnessKeyFingerprint(publicKey);
  const config = {
    apiUrl: "https://api.allowly.ai",
    appUrl: "https://app.allowly.ai",
    accessToken: "test-setup-secret",
    workspaceId: "ws_test",
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.allowly.ai/v1/setup/witness-key");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-setup-secret" });
    return new Response(JSON.stringify({
      workspace_id: "ws_test",
      public_key: publicKey,
      fingerprint_sha256: `sha256:${fingerprint}`,
      kms_key_version: "projects/test/cryptoKeyVersions/1",
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { directory, helper, publicKey, fingerprint, config, fetch };
}

test("requires the browser fingerprint before pinning the workspace key", async () => {
  const { directory, helper, fingerprint, config } = await fixture();
  const opened = vi.fn(() => true);
  const confirmed = vi.fn(async () => `sha256:${fingerprint}`);
  const result = await setupWitness(config, {
    helper,
    openBrowser: opened,
    confirmFingerprint: confirmed,
  });
  expect(opened).toHaveBeenCalledWith("https://app.allowly.ai/witness-key?workspace_id=ws_test");
  expect(confirmed).toHaveBeenCalledWith(
    fingerprint,
    "https://app.allowly.ai/witness-key?workspace_id=ws_test",
    "projects/test/cryptoKeyVersions/1",
  );
  const saved = JSON.parse(await readFile(join(directory, "witness", "ws_test", "config.json"), "utf8"));
  expect(saved).toEqual({
    version: 1,
    workspaceId: "ws_test",
    trustedNotaryKeyPath: result.trustedNotaryKeyPath,
    nativeBinaryPath: result.nativeBinaryPath,
    fingerprintSha256: fingerprint,
  });
  expect((await stat(result.trustedNotaryKeyPath)).mode & 0o777).toBe(0o600);
  expect((await stat(result.nativeBinaryPath)).mode & 0o777).toBe(0o700);
});

test("pins a local witness CA separately from the workspace witness key", async () => {
  const { directory, helper, fingerprint, config } = await fixture();
  const ca = Buffer.from("-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----\n");
  const source = join(directory, "local-ca.pem");
  await writeFile(source, ca);
  await setupWitness(config, {
    helper, witnessCaCert: source, openBrowser: () => true,
    confirmFingerprint: async () => fingerprint,
  });
  const saved = JSON.parse(await readFile(join(directory, "witness", "ws_test", "config.json"), "utf8"));
  expect(saved.trustedWitnessCaPath).toBe(join(directory, "witness", "ws_test", "witness-ca.pem"));
  expect(saved.witnessCaFingerprintSha256).toBe(createHash("sha256").update(ca).digest("hex"));
  expect(await readFile(saved.trustedWitnessCaPath)).toEqual(ca);
  expect((await stat(saved.trustedWitnessCaPath)).mode & 0o777).toBe(0o600);
});

test.each([
  ["saved dashboard", "https://dashboard.allowly.test", undefined, "https://dashboard.allowly.test"],
  ["browser override", "https://dashboard.allowly.test", "https://localhost:8843", "https://localhost:8843"],
  ["legacy app URL", undefined, undefined, "http://127.0.0.1:8480"],
] as const)("uses %s only for the browser link", async (_name, dashboardUrl, appUrl, expectedOrigin) => {
  const { directory, helper, fingerprint, config, fetch } = await fixture();
  const selected = {
    ...config, appUrl: "http://127.0.0.1:8480",
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
  };
  const before = JSON.stringify(selected);
  const loginPath = join(directory, "config.json");
  await writeFile(loginPath, before, { mode: 0o600 });
  const opened = vi.fn(() => true);
  const confirmed = vi.fn(async () => fingerprint);
  await setupWitness(selected, { helper, appUrl, openBrowser: opened, confirmFingerprint: confirmed });
  expect(opened).toHaveBeenCalledWith(`${expectedOrigin}/witness-key?workspace_id=ws_test`);
  expect(confirmed).toHaveBeenCalledWith(
    fingerprint, `${expectedOrigin}/witness-key?workspace_id=ws_test`, "projects/test/cryptoKeyVersions/1",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(selected)).toBe(before);
  expect(await readFile(loginPath, "utf8")).toBe(before);
});

test("browser override cannot bypass fingerprint confirmation", async () => {
  const { directory, helper, config } = await fixture();
  const opened = vi.fn(() => true);
  await expect(setupWitness(config, {
    helper, appUrl: "https://localhost:8843", openBrowser: opened,
    confirmFingerprint: async () => "0".repeat(64),
  })).rejects.toThrow("browser fingerprint was not confirmed");
  expect(opened).toHaveBeenCalledWith("https://localhost:8843/witness-key?workspace_id=ws_test");
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(directory, "bin", `allowly-witness-poc-0.1.0-${witnessTarget()}`))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  "javascript:alert(1)", "file:///private/tmp/dashboard", "https://user:password@dashboard.allowly.test",
])("rejects unsafe browser base %s before helper or API side effects", async (appUrl) => {
  const { directory, helper, config, fetch } = await fixture();
  // If helper validation ran first, its failure would hide the bad URL.
  await writeFile(helper, "#!/bin/sh\nexit 1\n");
  const opened = vi.fn(() => true);
  const confirmed = vi.fn(async () => "unused");
  let failure: unknown;
  try {
    await setupWitness(config, { helper, appUrl, openBrowser: opened, confirmFingerprint: confirmed });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain("command failed");
  expect((failure as Error).message).toMatch(/url|http|browser|dashboard/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(confirmed).not.toHaveBeenCalled();
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("wrong browser fingerprint leaves no pinned config or installed helper", async () => {
  const { directory, helper, config } = await fixture();
  await expect(setupWitness(config, {
    helper,
    openBrowser: () => true,
    confirmFingerprint: async () => "0".repeat(64),
  })).rejects.toThrow("browser fingerprint was not confirmed");
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects a malformed or different workspace key before confirmation", async () => {
  const { directory, helper, config, publicKey, fetch } = await fixture();
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
    workspace_id: "ws_other",
    public_key: publicKey,
    fingerprint_sha256: `sha256:${createHash("sha256").update("wrong").digest("hex")}`,
    kms_key_version: "projects/test/cryptoKeyVersions/1",
  }), { status: 200 }));
  const confirmFingerprint = vi.fn(async () => "unused");
  await expect(setupWitness(config, {
    helper,
    openBrowser: () => true,
    confirmFingerprint,
  })).rejects.toThrow("does not match the logged-in workspace");
  expect(confirmFingerprint).not.toHaveBeenCalled();
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects an archive whose SHA-256 does not match before saving trust", async () => {
  const { directory, fingerprint, config } = await fixture();
  const archive = join(directory, `allowly-witness-poc-0.1.1-${witnessTarget()}.tar.gz`);
  await writeFile(archive, "wrong archive bytes");
  await expect(setupWitness(config, {
    archive,
    archiveSha256: "0".repeat(64),
    openBrowser: () => true,
    confirmFingerprint: async () => fingerprint,
  })).rejects.toThrow("archive SHA-256 mismatch");
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("source selection failures do not make API requests or save configuration", async () => {
  const { directory, helper, config, fetch } = await fixture();
  const confirmFingerprint = vi.fn();
  await expect(setupWitness(config, {
    helper, buildFromSource: true, openBrowser: () => true, confirmFingerprint,
  })).rejects.toThrow("cannot be combined");
  expect(fetch).not.toHaveBeenCalled();
  expect(confirmFingerprint).not.toHaveBeenCalled();
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a helper that fails validation is never installed or used for trust setup", async () => {
  const { directory, helper, config, fetch } = await fixture();
  await writeFile(helper, "#!/bin/sh\nexit 1\n");
  await expect(setupWitness(config, {
    helper, openBrowser: () => true, confirmFingerprint: async () => "unused",
  })).rejects.toThrow("command failed");
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(join(directory, "bin", `allowly-witness-poc-0.1.0-${witnessTarget()}`))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
