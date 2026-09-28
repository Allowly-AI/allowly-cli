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
  const archive = join(directory, `allowly-witness-poc-0.1.0-${witnessTarget()}.tar.gz`);
  await writeFile(archive, "wrong archive bytes");
  await expect(setupWitness(config, {
    archive,
    archiveSha256: "0".repeat(64),
    openBrowser: () => true,
    confirmFingerprint: async () => fingerprint,
  })).rejects.toThrow("archive SHA-256 mismatch");
  await expect(readFile(join(directory, "witness", "ws_test", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
