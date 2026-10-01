import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";

import { HELPER_NAME, prepareWitnessHelper, validateWitnessSource } from "./witnessInstaller.js";
import { WITNESS_RELEASE } from "./witnessRelease.js";
import { witnessTarget } from "./witnessSetup.js";

const target = "aarch64-apple-darwin";
const version = "0.1.0";
const baseUrl = "https://github.com/Allowly-AI/allowly-mcp/releases/download/witness-v0.1.0/";
const binaryName = `${HELPER_NAME}-${version}-${target}.tar.gz`;
const sourceName = `${HELPER_NAME}-${version}-source.tar.gz`;
const helper = Buffer.from("#!/bin/sh\nexit 0\n");
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function tar(entries: Array<[string, Buffer, string?]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes, type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000700\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((value, byte) => value + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const sourceFiles: Array<[string, Buffer]> = [
  ["Cargo.toml", Buffer.from("[package]\nname = 'allowly-witness-poc'\n")],
  ["Cargo.lock", Buffer.from("version = 4\n")],
  ["rust-toolchain.toml", Buffer.from("[toolchain]\nchannel = '1.95.0'\n")],
  ["src/main.rs", Buffer.from("fn main() {}\n")],
  ["scripts/prepare_tlsn.sh", Buffer.from("#!/bin/bash\nexit 0\n")],
];

function releaseFixture(archive = tar([[HELPER_NAME, helper]]), filename = binaryName) {
  const manifest = Buffer.from(`${sha256(archive)}  ${filename}\n`);
  const release = { version, baseUrl, manifestSha256: sha256(manifest) };
  const fetchRelease = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toEqual({ Accept: "application/octet-stream" });
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    if (String(url) === `${baseUrl}SHA256SUMS`) return new Response(manifest);
    if (String(url) === `${baseUrl}${filename}`) return new Response(new Uint8Array(archive));
    throw new Error(`unexpected release request: ${url}`);
  });
  return { archive, manifest, release, fetchRelease };
}

test("pins the published helper release defaults", () => {
  expect(WITNESS_RELEASE).toEqual({
    version: "0.1.1",
    baseUrl: "https://github.com/Allowly-AI/allowly-mcp/releases/download/witness-v0.1.1/",
    manifestSha256: "969ab8e5cc2654e52cb2336c39d116480941acc13c563d98cecde62de440cc5a",
  });
});

test("downloads the pinned manifest and verifies the compiled helper before returning bytes", async () => {
  const fixture = releaseFixture();
  const run = vi.fn(async (_command: string, _args: string[], _cwd?: string, _timeout?: number) => "");
  expect(await prepareWitnessHelper({}, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).toEqual(helper);
  expect(fixture.fetchRelease).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map((call) => call[1])).toEqual([
    ["--help"], ["prove-execute", "--help"], ["verify-execute-attestation", "--help"],
  ]);
  await expect(readFile(run.mock.calls[0][0])).rejects.toMatchObject({ code: "ENOENT" });
});

test("fails closed with no network when the release manifest is not pinned", async () => {
  const fetchRelease = vi.fn();
  await expect(prepareWitnessHelper({}, target, { release: { version, baseUrl, manifestSha256: null }, fetch: fetchRelease })).rejects.toThrow("not published yet");
  expect(fetchRelease).not.toHaveBeenCalled();
});

test("rejects a manifest digest mismatch before fetching executable bytes", async () => {
  const fixture = releaseFixture();
  fixture.release.manifestSha256 = "0".repeat(64);
  await expect(prepareWitnessHelper({}, target, { release: fixture.release, fetch: fixture.fetchRelease })).rejects.toThrow("SHA256SUMS SHA-256 mismatch");
  expect(fixture.fetchRelease).toHaveBeenCalledTimes(1);
});

test("rejects archive digest mismatch without executing it", async () => {
  const fixture = releaseFixture();
  fixture.fetchRelease.mockImplementationOnce(async () => new Response(fixture.manifest));
  fixture.fetchRelease.mockImplementationOnce(async () => new Response("changed"));
  const run = vi.fn();
  await expect(prepareWitnessHelper({}, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).rejects.toThrow("archive SHA-256 mismatch");
  expect(run).not.toHaveBeenCalled();
});

test("reports a missing platform asset without silently building from source", async () => {
  const fixture = releaseFixture();
  await expect(prepareWitnessHelper({}, "x86_64-apple-darwin", { release: fixture.release, fetch: fixture.fetchRelease })).rejects.toThrow("not published for x86_64-apple-darwin");
  expect(fixture.fetchRelease).toHaveBeenCalledTimes(1);
});

test.each([
  "https://evil.example/helper.tar.gz",
  "http://release-assets.githubusercontent.com/helper.tar.gz",
  "https://user:password@release-assets.githubusercontent.com/helper.tar.gz",
])("rejects untrusted release redirects: %s", async (location) => {
  const fixture = releaseFixture();
  const fetchRelease = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
  await expect(prepareWitnessHelper({}, target, { release: fixture.release, fetch: fetchRelease })).rejects.toThrow("untrusted download host");
  expect(fetchRelease).toHaveBeenCalledTimes(1);
});

test("allows GitHub release asset redirects without forwarding setup credentials", async () => {
  const fixture = releaseFixture();
  const fetchRelease = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toEqual({ Accept: "application/octet-stream" });
    return new Response(new Uint8Array(fixture.archive));
  });
  fetchRelease.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/release/manifest" } }));
  fetchRelease.mockImplementationOnce(async () => new Response(fixture.manifest));
  expect(await prepareWitnessHelper({}, target, { release: fixture.release, fetch: fetchRelease, run: async () => "" })).toEqual(helper);
  expect(fetchRelease.mock.calls[1][0]).toBe("https://release-assets.githubusercontent.com/release/manifest");
});

test("rejects a download over its size bound before reading or executing it", async () => {
  const fixture = releaseFixture();
  const fetchRelease = vi.fn(async () => new Response("oversize", { headers: { "content-length": "999999999" } }));
  await expect(prepareWitnessHelper({}, target, { release: fixture.release, fetch: fetchRelease })).rejects.toThrow("too large");
});

test.each([
  `${"0".repeat(64)}  ../helper\n`,
  `${"0".repeat(64)}  ${binaryName}\n${"1".repeat(64)}  ${binaryName}\n`,
  `${"0".repeat(64)} *${binaryName}\n`,
  `${"0".repeat(64)}  ${binaryName}  \n`,
])("rejects malformed verified manifests", async (text) => {
  const manifest = Buffer.from(text);
  const release = { version, baseUrl, manifestSha256: sha256(manifest) };
  const fetchRelease = vi.fn(async () => new Response(manifest));
  await expect(prepareWitnessHelper({}, target, { release, fetch: fetchRelease })).rejects.toThrow("SHA256SUMS is malformed");
  expect(fetchRelease).toHaveBeenCalledTimes(1);
});

test.each<{ entries: Array<[string, Buffer, string?]> }>([
  { entries: [["../allowly-witness-poc", helper]] },
  { entries: [[HELPER_NAME, helper, "2"]] },
  { entries: [[HELPER_NAME, helper], ["extra", helper]] },
])("rejects unsafe archives and additional executables", async ({ entries }) => {
  const fixture = releaseFixture(tar(entries));
  const run = vi.fn();
  await expect(prepareWitnessHelper({}, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).rejects.toThrow(/archive/);
  expect(run).not.toHaveBeenCalled();
});

test("builds verified adapter source with installed tools, locked Cargo, and the pinned TLSNotary preparation", async () => {
  const fixture = releaseFixture(tar(sourceFiles), sourceName);
  const run = vi.fn(async (command: string, args: string[], cwd?: string) => {
    if (command === "rustc") return "rustc 1.95.0 (test)";
    if (command === "cargo" && args[0] === "build") {
      const output = join(cwd!, "target", target, "release", HELPER_NAME);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, helper);
    }
    return "";
  });
  expect(await prepareWitnessHelper({ buildFromSource: true }, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).toEqual(helper);
  expect(run.mock.calls.slice(0, 4).map(([command, args]) => [command, args])).toEqual([
    ["rustc", ["--version"]], ["cargo", ["--version"]], ["git", ["--version"]],
    ["bash", ["scripts/prepare_tlsn.sh"]],
  ]);
  expect(run.mock.calls[4]).toEqual(["cargo", ["build", "--release", "--locked", "--bin", HELPER_NAME, "--target", target, "--target-dir", join(run.mock.calls[3][2]!, "target")], run.mock.calls[3][2], 1_200_000]);
  await expect(readFile(join(run.mock.calls[3][2]!, "Cargo.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("explicit Cargo target overrides a different global configured target and reads its routed output", async () => {
  const fixture = releaseFixture(tar(sourceFiles), sourceName);
  const globalTarget = "x86_64-unknown-linux-gnu";
  const run = vi.fn(async (command: string, args: string[], cwd?: string) => {
    if (command === "rustc") return "rustc 1.95.0";
    if (command === "cargo" && args[0] === "build") {
      const targetFlag = args.indexOf("--target");
      const buildTarget = targetFlag < 0 ? globalTarget : args[targetFlag + 1];
      const targetDirectory = args[args.indexOf("--target-dir") + 1];
      expect(buildTarget).toBe(target);
      expect(targetDirectory).toBe(join(cwd!, "target"));
      const output = join(targetDirectory, buildTarget, "release", HELPER_NAME);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, helper);
      await expect(readFile(join(targetDirectory, "release", HELPER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    }
    return "";
  });
  expect(await prepareWitnessHelper({ buildFromSource: true }, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).toEqual(helper);
});

test.each(["missing", "old", "build failure"])("source build failure (%s) returns no helper and removes temporary files", async (failure) => {
  const fixture = releaseFixture(tar(sourceFiles), sourceName);
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === "rustc") {
      if (failure === "missing") throw new Error("witness setup needs rustc");
      return failure === "old" ? "rustc 1.94.0" : "rustc 1.95.0";
    }
    if (command === "cargo" && args[0] === "build") throw new Error("build failed");
    return "";
  });
  await expect(prepareWitnessHelper({ buildFromSource: true }, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).rejects.toThrow(/needs rustc|require Rust 1.95.0|build failed/);
});

test("rejects unexpected source archive contents before running build tools", async () => {
  const fixture = releaseFixture(tar([...sourceFiles, ["scripts/evil.sh", helper]]), sourceName);
  const run = vi.fn();
  await expect(prepareWitnessHelper({ buildFromSource: true }, target, { release: fixture.release, fetch: fixture.fetchRelease, run })).rejects.toThrow("missing or unexpected files");
  expect(run).not.toHaveBeenCalled();
});

test("preserves offline archive installation without release requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "allowly-witness-archive-test-"));
  directories.push(directory);
  const archive = tar([[HELPER_NAME, helper]]);
  const path = join(directory, `${HELPER_NAME}-${WITNESS_RELEASE.version}-${target}.tar.gz`);
  await writeFile(path, archive);
  const fetchRelease = vi.fn();
  expect(await prepareWitnessHelper({ archive: path, archiveSha256: sha256(archive) }, target, { fetch: fetchRelease })).toEqual(helper);
  expect(fetchRelease).not.toHaveBeenCalled();
});

test.each([
  { buildFromSource: true, helper: "helper" },
  { buildFromSource: true, archive: binaryName, archiveSha256: "0".repeat(64) },
  { helper: "helper", archive: binaryName, archiveSha256: "0".repeat(64) },
  { archive: binaryName },
  { archiveSha256: "0".repeat(64) },
])("rejects conflicting or incomplete source flags", (options) => {
  expect(() => validateWitnessSource(options, target)).toThrow();
});

test("rejects unsupported platforms", () => {
  expect(() => witnessTarget("win32", "x64")).toThrow("not packaged");
});
