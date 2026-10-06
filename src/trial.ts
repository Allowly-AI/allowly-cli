import { randomBytes, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, DEFAULT_APP_URL, readConfig, writeConfig } from "./config.js";
import { apiRequest } from "./http.js";

interface Bootstrap {
  trial_id: string;
  account_id: string;
  workspace_id: string;
  workspace_name: string;
  api_url: string;
  access_token: string;
  token_type: "Bearer";
  expires_at: string;
  claim_url: string;
  status_url: string;
  decisions_included: number;
  status: "unclaimed";
}

interface TrialState {
  version: 1;
  appUrl: string;
  name: string;
  idempotencyKey: string;
  recoverySecret: string;
  bootstrap?: Bootstrap;
}

function paths() {
  const directory = dirname(configPath());
  return { state: join(directory, "trial.json"), claim: join(directory, "trial-claim-url.txt") };
}

function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Trial URLs must use HTTPS, or HTTP on localhost, without credentials or a path.");
  }
  return url.origin;
}

function validIds(value: Bootstrap): boolean {
  return [value.trial_id, value.account_id, value.workspace_id].every(
    (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
  );
}

function validateBootstrap(value: Bootstrap, state: TrialState): Bootstrap {
  if (!value || !validIds(value) || typeof value.workspace_name !== "string"
      || !value.workspace_name || value.workspace_name.length > 120
      || typeof value.access_token !== "string" || !value.access_token
      || value.token_type !== "Bearer" || value.status !== "unclaimed"
      || value.decisions_included !== 1000 || typeof value.expires_at !== "string"
      || Number.isNaN(Date.parse(value.expires_at))) throw new Error("Invalid trial bootstrap response; saved recovery proof was kept.");
  origin(value.api_url);
  const claim = new URL(value.claim_url);
  origin(claim.origin);
  if (claim.origin !== state.appUrl || claim.username || claim.password || claim.search || claim.pathname !== `/claim/${value.trial_id}`
      || !/^#token=[A-Za-z0-9_-]{43,128}$/.test(claim.hash)
      || value.status_url !== `${state.appUrl}/v1/agent-trials/${value.trial_id}`
      || (state.bootstrap && ["trial_id", "account_id", "workspace_id"].some(
        (field) => value[field as keyof Bootstrap] !== state.bootstrap![field as keyof Bootstrap],
      ))) throw new Error("Trial response does not match the saved trial; recovery proof was kept.");
  return value;
}

async function readState(): Promise<TrialState> {
  const raw = await readFile(paths().state, "utf8");
  let state: TrialState;
  try { state = JSON.parse(raw) as TrialState; } catch {
    throw new Error("Saved trial state is corrupt. Keep it for recovery; do not create a replacement trial.");
  }
  if (!state || state.version !== 1 || typeof state.name !== "string" || !state.name || state.name.length > 120
      || typeof state.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(state.idempotencyKey)
      || typeof state.recoverySecret !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(state.recoverySecret)) {
    throw new Error("Saved trial state is invalid. Keep it for recovery; do not create a replacement trial.");
  }
  origin(state.appUrl);
  if (state.bootstrap) validateBootstrap(state.bootstrap, state);
  return state;
}

async function protectedWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function saveBootstrap(state: TrialState, response: Bootstrap): Promise<Record<string, unknown>> {
  const bootstrap = validateBootstrap(response, state);
  // Save the response before config/claim writes so a disk interruption needs no secret rotation.
  await protectedWrite(paths().state, JSON.stringify({ ...state, bootstrap }, null, 2) + "\n");
  await ensureTrialConfig(bootstrap.workspace_id);
  await writeConfig({ apiUrl: bootstrap.api_url, appUrl: state.appUrl,
    dashboardUrl: new URL(bootstrap.claim_url).origin, accessToken: bootstrap.access_token,
    workspaceId: bootstrap.workspace_id, workspaceName: bootstrap.workspace_name, expiresAt: bootstrap.expires_at });
  await protectedWrite(paths().claim, bootstrap.claim_url + "\n");
  return bootstrapMetadata(bootstrap);
}

function bootstrapMetadata(bootstrap: Bootstrap): Record<string, unknown> {
  return { trial_id: bootstrap.trial_id, account_id: bootstrap.account_id, workspace_id: bootstrap.workspace_id,
    workspace_name: bootstrap.workspace_name, api_url: bootstrap.api_url, status: bootstrap.status,
    expires_at: bootstrap.expires_at, decisions_included: bootstrap.decisions_included,
    status_url: bootstrap.status_url, config_file: configPath(), recovery_file: paths().state, claim_file: paths().claim };
}

async function ensureTrialConfig(workspaceId?: string): Promise<void> {
  try {
    const config = await readConfig();
    if (!workspaceId || config.workspaceId !== workspaceId) {
      throw new Error("CLI config belongs to another workspace. Use the original trial ALLOWLY_CONFIG_DIR.");
    }
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("Allowly CLI is not configured."))) throw err;
  }
}

export async function trialCommand(command: string, options: { name?: string; appUrl?: string }): Promise<Record<string, unknown>> {
  if (!["create", "status", "recover"].includes(command)) throw new Error("Use allowly trial create, status, or recover.");
  await mkdir(dirname(paths().state), { recursive: true, mode: 0o700 });
  const lock = `${paths().state}.lock`;
  // Secret reissuance is serialized locally; a dead process leaves a recoverable lock.
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(await readFile(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid trial lock; inspect the protected state before retrying.");
    try { process.kill(pid, 0); } catch (check) {
      if ((check as NodeJS.ErrnoException).code === "ESRCH") {
        // An exclusive stale marker elects one cleaner, preventing competing
        // retry processes from deleting a newly acquired lock.
        const stale = `${lock}.stale`;
        await link(lock, stale);
        try {
          await unlink(lock);
          return await trialCommand(command, options);
        } finally {
          await unlink(stale);
        }
      }
      throw check;
    }
    throw new Error("Another trial command is running. Retry after it finishes.");
  }
  try {
    let state: TrialState;
    try { state = await readState(); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (command !== "create") throw new Error("No saved trial. Run allowly trial create first.");
      try {
        await access(configPath());
        throw new Error("CLI is already configured. Use a separate ALLOWLY_CONFIG_DIR for a new trial.");
      } catch (configError) {
        if ((configError as NodeJS.ErrnoException).code !== "ENOENT") throw configError;
      }
      const name = options.name ?? "Agent trial";
      if (!name.trim() || name.length > 120) throw new Error("Trial name must contain 1–120 characters.");
      state = { version: 1, name, appUrl: origin(options.appUrl ?? DEFAULT_APP_URL),
        idempotencyKey: randomUUID(), recoverySecret: randomBytes(32).toString("base64url") };
      await protectedWrite(paths().state, JSON.stringify(state, null, 2) + "\n");
    }
    if ((options.name !== undefined && options.name !== state.name)
        || (options.appUrl !== undefined && origin(options.appUrl) !== state.appUrl)) {
      throw new Error("Use the saved trial name and app URL when resuming. A retry cannot create a different trial.");
    }
    await ensureTrialConfig(state.bootstrap?.workspace_id);
    const config = { apiUrl: state.appUrl, accessToken: state.recoverySecret };
    if (command === "create") {
      if (state.bootstrap) {
        const status = await apiRequest<{ status: string; expired: boolean }>(config, "GET", `/v1/agent-trials/${state.bootstrap.trial_id}`);
        if (status.status !== "unclaimed" || status.expired !== false) {
          throw new Error("Trial bootstrap access has ended. Hand the protected claim link to its intended human.");
        }
        try {
          await access(configPath());
          await protectedWrite(paths().claim, state.bootstrap.claim_url + "\n");
          return bootstrapMetadata(state.bootstrap);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        return await saveBootstrap(state, state.bootstrap);
      }
      const bootstrap = await apiRequest<Bootstrap>(config, "POST", "/v1/agent-trials",
        { name: state.name, recovery_secret: state.recoverySecret }, 30_000, { "Idempotency-Key": state.idempotencyKey });
      return await saveBootstrap(state, bootstrap);
    }
    if (!state.bootstrap) throw new Error("Bootstrap response was interrupted. Rerun allowly trial create with the saved options.");
    const endpoint = `/v1/agent-trials/${state.bootstrap.trial_id}`;
    if (command === "recover") return await saveBootstrap(state, await apiRequest<Bootstrap>(config, "POST", `${endpoint}/recover`));
    const status = await apiRequest<Bootstrap & { decisions_used: number; decisions_remaining: number; expired: boolean }>(config, "GET", endpoint);
    if (!status || !validIds(status) || status.trial_id !== state.bootstrap.trial_id
        || status.workspace_id !== state.bootstrap.workspace_id || status.account_id !== state.bootstrap.account_id
        || !["unclaimed", "claiming", "claimed"].includes(status.status)
        || status.decisions_included !== 1000 || typeof status.expired !== "boolean"
        || !Number.isSafeInteger(status.decisions_used) || status.decisions_used < 0
        || !Number.isSafeInteger(status.decisions_remaining) || status.decisions_remaining < 0) {
      throw new Error("Invalid trial status response.");
    }
    return { trial_id: status.trial_id, account_id: status.account_id, workspace_id: status.workspace_id,
      status: status.status, expires_at: state.bootstrap.expires_at, expired: status.expired,
      decisions_included: status.decisions_included, decisions_used: status.decisions_used,
      decisions_remaining: status.decisions_remaining, claim_file: paths().claim };
  } finally {
    await unlink(lock);
  }
}
