import { mkdir, readFile, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://api.allowly.ai";
export const DEFAULT_APP_URL = "https://app.allowly.ai";

export interface CliConfig {
  apiUrl: string;
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
  const parsed = JSON.parse(raw) as Partial<CliConfig> & { setupToken?: string };
  const accessToken = parsed.accessToken ?? parsed.setupToken;
  if (!parsed.apiUrl || !accessToken) {
    throw new Error("Allowly CLI config is missing apiUrl or accessToken. Run `allowly login` again.");
  }
  return {
    apiUrl: parsed.apiUrl.replace(/\/$/, ""),
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
