import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { WITNESS_RELEASE } from "./witnessRelease.js";

export const HELPER_NAME = "allowly-witness-poc";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 256;
const MAX_MANIFEST_BYTES = 32 * 1024;
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"];
const execFileAsync = promisify(execFile);

export interface WitnessInstallOptions {
  archive?: string;
  archiveSha256?: string;
  helper?: string;
  buildFromSource?: boolean;
}

interface InstallDependencies {
  release: typeof WITNESS_RELEASE;
  fetch: typeof fetch;
  run: (command: string, args: string[], cwd?: string, timeout?: number) => Promise<string>;
}

async function run(command: string, args: string[], cwd?: string, timeout = 30_000): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, RUSTUP_AUTO_INSTALL: "0" };
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET;
  delete env.RUSTUP_TOOLCHAIN;
  try {
    const result = await execFileAsync(command, args, { cwd, env, timeout, maxBuffer: 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: string; stderr?: string };
    if (failure.code === "ENOENT") throw new Error(`witness setup needs ${command}; install it and run setup again`);
    throw new Error(`witness setup command failed: ${command} ${args.join(" ")}${failure.stderr ? `\n${failure.stderr.slice(-2000)}` : ""}`);
  }
}

export function validateWitnessSource(options: WitnessInstallOptions, target: string): void {
  const offline = options.helper !== undefined || options.archive !== undefined || options.archiveSha256 !== undefined;
  if (options.buildFromSource && offline) throw new Error("--build-from-source cannot be combined with --helper, --archive, or --sha256");
  if (options.helper !== undefined && (options.archive !== undefined || options.archiveSha256 !== undefined)) {
    throw new Error("use either --helper or --archive with --sha256");
  }
  if ((options.archive === undefined) !== (options.archiveSha256 === undefined)) throw new Error("--archive and --sha256 must be used together");
  if (options.archive !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(options.archiveSha256!)) throw new Error("--sha256 must be 64 lowercase hex characters");
    const expectedName = `${HELPER_NAME}-${WITNESS_RELEASE.version}-${target}.tar.gz`;
    if (basename(options.archive) !== expectedName) throw new Error(`witness archive must be named ${expectedName}`);
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarEntries(archive: Buffer, maxBytes = MAX_ARCHIVE_BYTES + 10 * 1024, maxFiles = 5000, maxArchiveBytes = MAX_ARCHIVE_BYTES): Map<string, Buffer> {
  if (archive.length > maxArchiveBytes) throw new Error("witness archive is too large");
  const tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error("witness archive has an invalid trailer");
      if (files.size === 0) throw new Error("witness archive is empty");
      return files;
    }
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = field(124, 12).trim();
    const checksumText = field(148, 8).trim();
    let checksum = 8 * 32;
    for (let index = 0; index < 512; index++) if (index < 148 || index >= 156) checksum += header[index];
    if (!/^[0-7]+$/.test(checksumText) || checksum !== Number.parseInt(checksumText, 8)) throw new Error("witness archive header checksum mismatch");
    if (!/^[A-Za-z0-9_./-]+$/.test(fullName) || fullName.split("/").some((part) => part === "" || part === "." || part === "..")
        || (header[156] !== 0 && header[156] !== 48) || field(157, 100) !== "" || !/^[0-7]+$/.test(sizeText)) {
      throw new Error("witness archive must contain only safe regular files (no links or metadata entries)");
    }
    const size = Number.parseInt(sizeText, 8);
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (size < 1 || end > tar.length || files.has(fullName) || files.size >= maxFiles) throw new Error("witness archive has extra or invalid entries");
    files.set(fullName, tar.subarray(offset + 512, offset + 512 + size));
    offset = end;
  }
  throw new Error("witness archive is truncated");
}

function helperFromArchive(archive: Buffer): Buffer {
  const files = tarEntries(archive);
  if (files.size !== 1 || !files.has(HELPER_NAME)) throw new Error("witness helper archive must contain one regular helper file");
  if (files.get(HELPER_NAME)!.length > MAX_ARCHIVE_BYTES) throw new Error("witness helper archive binary is too large");
  return files.get(HELPER_NAME)!;
}

async function boundedFile(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("witness installer input must be a regular file");
  if (info.size < 1 || info.size > MAX_ARCHIVE_BYTES) throw new Error("witness installer input is empty or too large");
  const bytes = await readFile(path);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("witness installer input is too large");
  return bytes;
}

function safeDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
    throw new Error("witness release redirected to an untrusted download host");
  }
  return url;
}

async function download(url: string, maxBytes: number, fetchRelease: typeof fetch): Promise<Buffer> {
  let current = safeDownloadUrl(url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchRelease(current.toString(), {
      redirect: "manual", credentials: "omit", headers: { Accept: "application/octet-stream" }, signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("witness release download has an invalid redirect");
      current = safeDownloadUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status === 404) throw new Error("witness release assets are not published yet; use --archive FILE --sha256 HEX or --helper FILE");
    if (!response.ok || !response.body) throw new Error(`witness release download failed (HTTP ${response.status})`);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
      await response.body.cancel();
      throw new Error("witness release download is too large");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maxBytes) throw new Error("witness release download is too large");
        chunks.push(Buffer.from(part.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
  }
  throw new Error("witness release download has too many redirects");
}

function manifestEntries(manifest: Buffer, version: string): Map<string, string> {
  const entries = new Map<string, string>();
  const allowed = new Set([`${HELPER_NAME}-${version}-source.tar.gz`, ...TARGETS.map((target) => `${HELPER_NAME}-${version}-${target}.tar.gz`)]);
  for (const line of manifest.toString("utf8").replace(/\n$/, "").split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || !allowed.has(match[2]) || entries.has(match[2])) throw new Error("witness release SHA256SUMS is malformed");
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function releaseArchive(source: boolean, target: string, dependencies: InstallDependencies): Promise<Buffer> {
  const { release } = dependencies;
  if (!release.manifestSha256 || !/^[0-9a-f]{64}$/.test(release.manifestSha256)) {
    throw new Error("witness release assets are not published yet; use --archive FILE --sha256 HEX or --helper FILE");
  }
  const manifest = await download(`${release.baseUrl}SHA256SUMS`, MAX_MANIFEST_BYTES, dependencies.fetch);
  if (digest(manifest) !== release.manifestSha256) throw new Error("witness release SHA256SUMS SHA-256 mismatch");
  const entries = manifestEntries(manifest, release.version);
  const name = `${HELPER_NAME}-${release.version}-${source ? "source" : target}.tar.gz`;
  const expected = entries.get(name);
  if (!expected) throw new Error(`witness release asset is not published for ${source ? "source builds" : target}; try --build-from-source or an offline helper`);
  const archive = await download(`${release.baseUrl}${name}`, MAX_ARCHIVE_BYTES, dependencies.fetch);
  if (digest(archive) !== expected) throw new Error("witness release archive SHA-256 mismatch");
  return archive;
}

async function buildHelper(archive: Buffer, directory: string, target: string, runCommand: InstallDependencies["run"]): Promise<Buffer> {
  const files = tarEntries(archive, MAX_SOURCE_BYTES + MAX_SOURCE_FILES * 1024 + 10 * 1024, MAX_SOURCE_FILES, MAX_SOURCE_BYTES);
  const required = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "scripts/prepare_tlsn.sh"];
  if (required.some((name) => !files.has(name)) || [...files.keys()].some((name) =>
    !["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "scripts/prepare_tlsn.sh", "scripts/cargo.sh"].includes(name)
    && !/^src\/[A-Za-z0-9_./-]+\.rs$/.test(name))) throw new Error("witness source archive has missing or unexpected files");
  if ([...files.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_SOURCE_BYTES) throw new Error("witness source archive files are too large");
  const source = join(directory, "source");
  await mkdir(source, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
  // RUSTUP_AUTO_INSTALL=0 selects only the already installed pinned toolchain.
  const rustVersion = await runCommand("rustc", ["--version"], source);
  if (!/^rustc 1\.95\.0(?:\s|$)/.test(rustVersion)) throw new Error("witness source builds require Rust 1.95.0; install that toolchain and run setup again");
  await runCommand("cargo", ["--version"], source);
  await runCommand("git", ["--version"], source);
  await runCommand("bash", ["scripts/prepare_tlsn.sh"], source, 600_000);
  await runCommand("cargo", ["build", "--release", "--locked", "--bin", HELPER_NAME, "--target", target, "--target-dir", join(source, "target")], source, 1_200_000);
  return boundedFile(join(source, "target", target, "release", HELPER_NAME));
}

/** Prepare and test bytes in a private temporary directory; never installs or saves trust. */
export async function prepareWitnessHelper(options: WitnessInstallOptions, target: string, overrides: Partial<InstallDependencies> = {}): Promise<Buffer> {
  validateWitnessSource(options, target);
  const dependencies: InstallDependencies = { release: WITNESS_RELEASE, fetch: globalThis.fetch, run, ...overrides };
  const directory = await mkdtemp(join(tmpdir(), "allowly-witness-install-"));
  await chmod(directory, 0o700);
  try {
    let helper: Buffer;
    if (options.helper !== undefined) helper = await boundedFile(resolve(options.helper));
    else if (options.archive !== undefined) {
      const archive = await boundedFile(resolve(options.archive));
      if (digest(archive) !== options.archiveSha256) throw new Error("witness helper archive SHA-256 mismatch");
      helper = helperFromArchive(archive);
    } else {
      const archive = await releaseArchive(options.buildFromSource === true, target, dependencies);
      helper = options.buildFromSource ? await buildHelper(archive, directory, target, dependencies.run) : helperFromArchive(archive);
    }
    const executable = join(directory, HELPER_NAME);
    await writeFile(executable, helper, { flag: "wx", mode: 0o700 });
    for (const args of [["--help"], ["prove-execute", "--help"], ["verify-execute-attestation", "--help"]]) {
      await dependencies.run(executable, args, directory, 15_000);
    }
    return helper;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
