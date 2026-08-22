import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://api.allowly.ai";
export const DEFAULT_APP_URL = "https://app.allowly.ai";

export interface CliConfig {
  apiUrl: string;
  appUrl?: string;
  accessToken: string;
  expiresAt?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export function configPath(): string {
  const configDir = process.env.ALLOWLY_CONFIG_DIR ?? join(homedir(), ".allowly");
  return join(configDir, "config.json");
}

export async function readConfig(path = configPath()): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error("Allowly CLI is not configured. Run `allowly login` first.");
  }
  let parsed: Partial<CliConfig> & { setupToken?: string };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error();
    parsed = value as Partial<CliConfig> & { setupToken?: string };
  } catch {
    throw new Error("Allowly CLI config is corrupt. Run `allowly login` again.");
  }
  const accessToken = parsed.accessToken ?? parsed.setupToken;
  if (!parsed.apiUrl || !accessToken) {
    throw new Error("Allowly CLI config is missing apiUrl or accessToken. Run `allowly login` again.");
  }
  return {
    apiUrl: parsed.apiUrl.replace(/\/$/, ""),
    appUrl: (parsed.appUrl ?? DEFAULT_APP_URL).replace(/\/$/, ""),
    accessToken,
    expiresAt: parsed.expiresAt,
    workspaceId: parsed.workspaceId,
    workspaceName: parsed.workspaceName,
  };
}

export async function writeConfig(config: CliConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify(
      {
        apiUrl: config.apiUrl.replace(/\/$/, ""),
        appUrl: config.appUrl?.replace(/\/$/, ""),
        accessToken: config.accessToken,
        expiresAt: config.expiresAt,
        workspaceId: config.workspaceId,
        workspaceName: config.workspaceName,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

export async function removeConfig(path = configPath()): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

export async function removeConfigIfCredentialMatches(
  accessToken: string,
  path = configPath(),
): Promise<boolean> {
  const claimPath = `${path}.logout-${process.pid}-${randomUUID()}`;
  try {
    // Claim exactly one config generation before inspecting it.
    await rename(path, claimPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }

  let matches = false;
  try {
    const value: unknown = JSON.parse(await readFile(claimPath, "utf8"));
    if (value && typeof value === "object") {
      const parsed = value as { accessToken?: unknown; setupToken?: unknown };
      matches = (parsed.accessToken ?? parsed.setupToken) === accessToken;
    }
  } catch {
    // Keep malformed or unreadable config rather than deleting it.
  }

  if (matches) {
    await unlink(claimPath);
    return true;
  }

  try {
    // A hard link restores the claim only when a newer login has not recreated the path.
    await link(claimPath, path);
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
  await unlink(claimPath);
  return false;
}
