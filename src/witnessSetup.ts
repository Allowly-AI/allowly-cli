import { ECDH, createHash, randomUUID } from "node:crypto";
import { copyFile, chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { CliConfig } from "./config.js";
import { DEFAULT_APP_URL } from "./config.js";
import { apiRequest } from "./http.js";

const HELPER_VERSION = "0.1.0";
const HELPER_NAME = "allowly-witness-poc";
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

interface WitnessKeyResponse {
  workspace_id: string;
  public_key: { alg: number; data: number[] };
  fingerprint_sha256: string;
  kms_key_version: string;
}

export interface WitnessSetupOptions {
  archive?: string;
  archiveSha256?: string;
  helper?: string;
  witnessCaCert?: string;
  openBrowser: (url: string) => boolean;
  confirmFingerprint: (localFingerprint: string, pageUrl: string, kmsKeyVersion: string) => Promise<string>;
}

export function witnessTarget(platform = process.platform, arch = process.arch): string {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`witness helper is not packaged for ${platform}/${arch}`);
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  if (platform === "linux" && !report?.header?.glibcVersionRuntime) {
    throw new Error("witness helper currently requires glibc Linux");
  }
  return target;
}

export function witnessKeyFingerprint(key: unknown): string {
  if (key === null || typeof key !== "object" || Array.isArray(key)
      || (key as { alg?: unknown }).alg !== 2
      || !Array.isArray((key as { data?: unknown }).data)
      || !(key as { data: unknown[] }).data.every((value) => Number.isInteger(value)
        && (value as number) >= 0 && (value as number) <= 255)) {
    throw new Error("workspace witness public key must be a TLSNotary P-256 key");
  }
  let compressed: Buffer;
  try {
    compressed = ECDH.convertKey(
      Buffer.from((key as { data: number[] }).data),
      "prime256v1", undefined, undefined, "compressed",
    ) as Buffer;
  } catch {
    throw new Error("workspace witness public key is not a valid P-256 point");
  }
  return createHash("sha256").update(compressed).digest("hex");
}

function configDirectory(): string {
  return resolve(process.env.ALLOWLY_CONFIG_DIR ?? join(homedir(), ".allowly"));
}

function safeWorkspaceId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid witness workspace ID");
  return value;
}

function tarFile(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  if (tar.length < 1024) throw new Error("witness helper archive is empty");
  const name = tar.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const type = tar[156];
  const sizeText = tar.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
  if (name !== HELPER_NAME || (type !== 0 && type !== 48) || !/^[0-7]+$/.test(sizeText)) {
    throw new Error("witness helper archive must contain one regular helper file");
  }
  const size = Number.parseInt(sizeText, 8);
  const end = 512 + Math.ceil(size / 512) * 512;
  if (size < 1 || end + 1024 > tar.length || tar.subarray(end).some((byte) => byte !== 0)) {
    throw new Error("witness helper archive has extra or invalid entries");
  }
  return tar.subarray(512, 512 + size);
}

async function atomicWrite(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function installHelper(options: WitnessSetupOptions): Promise<string> {
  const target = witnessTarget();
  const binDirectory = join(configDirectory(), "bin");
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const installed = join(binDirectory, `${HELPER_NAME}-${HELPER_VERSION}-${target}`);
  if (options.helper !== undefined) {
    if (options.archive !== undefined || options.archiveSha256 !== undefined) {
      throw new Error("use either --helper or --archive with --sha256");
    }
    const source = resolve(options.helper);
    if (!(await lstat(source)).isFile()) throw new Error("witness helper must be a regular file");
    const temporary = `${installed}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary);
      await chmod(temporary, 0o700);
      await rename(temporary, installed);
    } catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return installed;
  }
  if (options.archive === undefined || options.archiveSha256 === undefined) {
    throw new Error("witness release assets are not published yet; use --archive FILE --sha256 HEX or --helper FILE");
  }
  if (!/^[0-9a-f]{64}$/.test(options.archiveSha256)) {
    throw new Error("--sha256 must be 64 lowercase hex characters");
  }
  const expectedName = `${HELPER_NAME}-${HELPER_VERSION}-${target}.tar.gz`;
  if (basename(options.archive) !== expectedName) {
    throw new Error(`witness archive must be named ${expectedName}`);
  }
  const archive = await readFile(options.archive);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("witness helper archive is too large");
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== options.archiveSha256) throw new Error("witness helper archive SHA-256 mismatch");
  await atomicWrite(installed, tarFile(archive), 0o700);
  return installed;
}

/** Install a local helper and pin the separately confirmed public key for one workspace. */
export async function setupWitness(config: CliConfig, options: WitnessSetupOptions): Promise<{
  workspaceId: string;
  fingerprintSha256: string;
  nativeBinaryPath: string;
  trustedNotaryKeyPath: string;
}> {
  if (!config.workspaceId) throw new Error("Run `allowly login` to select a workspace first");
  const workspaceId = safeWorkspaceId(config.workspaceId);
  // Source selection must be valid before making a remote request or asking for trust.
  const target = witnessTarget();
  if (options.helper !== undefined && (options.archive !== undefined || options.archiveSha256 !== undefined)) {
    throw new Error("use either --helper or --archive with --sha256");
  }
  if (options.helper === undefined && (options.archive === undefined || options.archiveSha256 === undefined)) {
    throw new Error("witness release assets are not published yet; use --archive FILE --sha256 HEX or --helper FILE");
  }
  if (options.archive !== undefined) {
    if (options.archiveSha256 === undefined || !/^[0-9a-f]{64}$/.test(options.archiveSha256)) {
      throw new Error("--sha256 must be 64 lowercase hex characters");
    }
    const expectedName = `${HELPER_NAME}-${HELPER_VERSION}-${target}.tar.gz`;
    if (basename(options.archive) !== expectedName) {
      throw new Error(`witness archive must be named ${expectedName}`);
    }
  }
  // A local witness uses a private CA. Keep that trust separate from the
  // public Web PKI used for the provider request.
  let witnessCaBytes: Buffer | undefined;
  if (options.witnessCaCert !== undefined) {
    const source = resolve(options.witnessCaCert);
    if (!(await lstat(source)).isFile()) throw new Error("witness CA certificate must be a regular file");
    witnessCaBytes = await readFile(source);
    if (witnessCaBytes.length < 1 || witnessCaBytes.length > 32 * 1024
        || !witnessCaBytes.toString("ascii").includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("witness CA certificate is not a valid PEM file");
    }
  }
  const key = await apiRequest<WitnessKeyResponse>(
    { ...config, apiUrl: config.apiUrl }, "GET", "/v1/setup/witness-key",
  );
  if (key.workspace_id !== workspaceId || typeof key.kms_key_version !== "string" || !key.kms_key_version) {
    throw new Error("workspace witness key response does not match the logged-in workspace");
  }
  const fingerprint = witnessKeyFingerprint(key.public_key);
  if (key.fingerprint_sha256 !== `sha256:${fingerprint}`) {
    throw new Error("workspace witness key fingerprint does not match the public key");
  }
  const pageUrl = new URL(`/witness-key?workspace_id=${encodeURIComponent(workspaceId)}`, config.appUrl ?? DEFAULT_APP_URL).toString();
  options.openBrowser(pageUrl);
  const entered = (await options.confirmFingerprint(fingerprint, pageUrl, key.kms_key_version))
    .trim().toLowerCase().replace(/^sha256:/, "");
  if (entered !== fingerprint) {
    throw new Error("browser fingerprint was not confirmed; witness setup was not saved");
  }
  const nativeBinaryPath = await installHelper(options);
  const workspaceDirectory = join(configDirectory(), "witness", workspaceId);
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  const trustedNotaryKeyPath = join(workspaceDirectory, "notary-public-key.json");
  await atomicWrite(trustedNotaryKeyPath, Buffer.from(JSON.stringify(key.public_key) + "\n"), 0o600);
  const trustedWitnessCaPath = witnessCaBytes === undefined
    ? undefined : join(workspaceDirectory, "witness-ca.pem");
  if (trustedWitnessCaPath !== undefined) {
    await atomicWrite(trustedWitnessCaPath, witnessCaBytes!, 0o600);
  }
  await atomicWrite(join(workspaceDirectory, "config.json"), Buffer.from(JSON.stringify({
    version: 1,
    workspaceId,
    trustedNotaryKeyPath,
    nativeBinaryPath,
    fingerprintSha256: fingerprint,
    ...(trustedWitnessCaPath === undefined ? {} : {
      trustedWitnessCaPath,
      witnessCaFingerprintSha256: createHash("sha256").update(witnessCaBytes!).digest("hex"),
    }),
  }, null, 2) + "\n"), 0o600);
  return { workspaceId, fingerprintSha256: fingerprint, nativeBinaryPath, trustedNotaryKeyPath };
}
