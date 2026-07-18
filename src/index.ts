#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_API_URL, DEFAULT_APP_URL, readConfig, removeConfig, writeConfig } from "./config.js";
import { AllowlyCliError, apiRequest, listAll } from "./http.js";
import {
  SETUP_TEMPLATE_ALIASES,
  SETUP_TEMPLATE_DESCRIPTIONS,
  SETUP_TEMPLATE_LABELS,
  SETUP_TEMPLATE_NAMES,
  getSetupTemplate,
  isSetupTemplateName,
  loadSetupConfig,
  writeSampleSetupConfig,
  type SetupTemplateName,
} from "./setupConfig.js";

interface RuntimeKeyResponse {
  id: string;
  key: string;
  prefix: string;
}

interface RuntimeConfig {
  apiUrl: string;
  accessToken: string;
}

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  status: "authorized";
  access_token: string;
  expires_at: string;
  api_url?: string;
  workspace_id: string;
  workspace_name: string;
}

function usage(): string {
  return `Allowly CLI

Allowly is API-first after account, email, and billing setup.
Run allowly login once, approve the CLI in your browser, then let Codex,
Claude Code, or a script configure actions, policies, and runtime API keys
without dashboard or billing access.

Commands:
  allowly login [--app-url <url>] [--api-url <url>] [--no-browser]
  allowly logout
  allowly status
  allowly init [--use-case ${SETUP_TEMPLATE_NAMES.join("|")}] [--file allowly.setup.json]
  allowly init --list-use-cases
  allowly init --manual
  allowly actions apply <allowly.setup.json>
  allowly policies apply <allowly.setup.json>
  allowly keys create [--write-env .env.local] [--var ALLOWLY_API_KEY]
  allowly setup guide
  allowly check --authorization-id <id> --action <action> [--resource <resource>] [--runtime-env .env.local]

Optional use-case seeds:
${SETUP_TEMPLATE_NAMES.map((name) => `  ${name.padEnd(20)} ${SETUP_TEMPLATE_DESCRIPTIONS[name]}`).join("\n")}

Typical agent flow:
  allowly login
  allowly init
  allowly actions apply allowly.setup.json
  allowly policies apply allowly.setup.json
  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY

Runtime check flow:
  allowly check --authorization-id auth_... --action web.search --resource user:123 --runtime-env .env.local
`;
}

function option(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

async function requestJson<T>(apiUrl: string, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok && response.status !== 202) {
    let errorBody: { error?: { code?: string; message?: string } } = {};
    try {
      errorBody = text ? JSON.parse(text) as typeof errorBody : {};
    } catch {
      // Non-JSON proxy errors still get a useful status message.
    }
    const message = errorBody.error?.message ?? `Allowly API returned ${response.status}`;
    const code = errorBody.error?.code ?? "error";
    throw new AllowlyCliError(message, response.status, code);
  }
  const data = text ? JSON.parse(text) as T : ({} as T);
  return { status: response.status, data };
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function commandLogin(args: string[]): Promise<void> {
  const setupToken = option(args, "--setup-token");
  const apiUrlOverride = option(args, "--api-url");
  const apiUrl = apiUrlOverride ?? DEFAULT_API_URL;
  const appUrl = option(args, "--app-url") ?? DEFAULT_APP_URL;
  if (setupToken) {
    await writeConfig({ apiUrl, accessToken: setupToken });
    console.log(`Allowly CLI configured for ${apiUrl.replace(/\/$/, "")}`);
    console.log("Manual setup-token login is supported for advanced flows; normal setup should use `allowly login`.");
    return;
  }

  const started = await requestJson<DeviceStartResponse>(appUrl, "/v1/cli/device/start", {});
  const device = started.data;
  const shouldOpenBrowser = !args.includes("--no-browser");
  const opened = shouldOpenBrowser ? openBrowser(device.verification_uri_complete) : false;
  console.log(opened ? "Opened browser for Allowly CLI authorization." : "Open this URL to authorize the CLI:");
  console.log(`  ${device.verification_uri_complete}`);
  console.log(`Code: ${device.user_code}`);
  console.log("Waiting for approval...");

  const deadline = Date.now() + device.expires_in * 1000;
  let pollIntervalMs = Math.max(1, device.interval || 3) * 1000;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    const tokenResponse = await requestJson<DeviceTokenResponse | { status: "pending"; interval?: number }>(
      appUrl,
      "/v1/cli/device/token",
      { device_code: device.device_code },
    );
    if (tokenResponse.status === 202 || tokenResponse.data.status === "pending") {
      const pending = tokenResponse.data as { status: "pending"; interval?: number };
      pollIntervalMs = Math.max(1, pending.interval ?? device.interval ?? 3) * 1000;
      continue;
    }
    const authorized = tokenResponse.data as DeviceTokenResponse;
    const configuredApiUrl = apiUrlOverride ?? authorized.api_url ?? DEFAULT_API_URL;
    await writeConfig({
      apiUrl: configuredApiUrl,
      accessToken: authorized.access_token,
      expiresAt: authorized.expires_at,
      workspaceId: authorized.workspace_id,
      workspaceName: authorized.workspace_name,
    });
    console.log(`Allowly CLI configured for ${authorized.workspace_name} (${configuredApiUrl.replace(/\/$/, "")})`);
    return;
  }
  throw new AllowlyCliError("CLI login code expired. Run `allowly login` again.", 401, "authorization_expired");
}

async function commandStatus(): Promise<void> {
  const config = await readConfig();
  const status = await apiRequest<Record<string, unknown>>(config, "GET", "/v1/setup/status");
  console.log(JSON.stringify(status, null, 2));
}

async function commandLogout(): Promise<void> {
  // ponytail: local-only logout. Setup tokens hard-expire server-side (<=24h);
  // immediate server-side revoke is Dashboard -> setup tokens.
  if (!(await removeConfig())) {
    console.log("Already logged out (no CLI config found).");
    return;
  }
  console.log("Removed local Allowly CLI config.");
  console.log("Setup tokens expire on their own within 24h; revoke immediately from the dashboard if needed.");
}

async function commandSetupGuide(): Promise<void> {
  let workspace = "Run `allowly login`, then `allowly status` to confirm the workspace.";
  try {
    const config = await readConfig();
    const status = await apiRequest<Record<string, unknown>>(config, "GET", "/v1/setup/status");
    workspace = `Workspace: ${String(status.workspace_name ?? "unknown")} (${String(status.workspace_id ?? "unknown")})`;
  } catch {
    // The guide should still be useful before login.
  }

  console.log(`Allowly setup guide

${workspace}

Setup order:
1. Define actions: individual permissions like web.search or lead.enrich.
2. Define policies: reusable groups of actions plus decision rules per agent/use case.
3. Create a runtime API key and store it in your app env or secret manager.
4. Your app creates authorizations from policy IDs and calls /v1/check before acting.

Setup file format:
{
  "actions": [
    {
      "name": "web.search",
      "description": "Search the public web.",
      "requires_confirm": false,
      "constraints_schema": {}
    }
  ],
  "policies": [
    {
      "policy_id": "marketing_user_enrichment",
      "agent_id": "marketing_user_enrichment",
      "description": "Enriches users with public marketing context.",
      "actions": [
        { "name": "web.search" }
      ],
      "requires_confirm_for": [],
      "requires_escalation_for": [],
      "requires_deny_for": [],
      "escalation_targets": {},
      "default_expiry_days": 90
    }
  ]
}

Apply:
  allowly actions apply allowly.setup.json
  allowly policies apply allowly.setup.json
  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY

Runtime check:
  allowly check --authorization-id auth_... --action web.search --resource user:123 --runtime-env .env.local

Security boundary:
- setup/login credentials configure actions, policies, and runtime keys.
- runtime API keys create authorizations and call /v1/check.
- the CLI does not sign receipts; the Allowly API signs receipts server-side.`);
}

function listUseCases(): void {
  for (const name of SETUP_TEMPLATE_NAMES) {
    console.log(`${name}: ${SETUP_TEMPLATE_DESCRIPTIONS[name]}`);
  }
  console.log("manual: I'll set it up myself");
}

function printApplyNextSteps(file: string): void {
  console.log("Review it, then run:");
  console.log(`  allowly actions apply ${file}`);
  console.log(`  allowly policies apply ${file}`);
  console.log("  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY");
}

function printManualNextSteps(): void {
  console.log("Manual setup selected. No setup file was created and no workspace resources were changed.");
  console.log("Create your own allowly.setup.json, then run:");
  console.log("  allowly actions apply allowly.setup.json");
  console.log("  allowly policies apply allowly.setup.json");
  console.log("  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY");
  console.log("Tip: use allowly init --list-use-cases to view optional use-case seeds.");
}

async function promptSetupChoice(): Promise<SetupTemplateName | "manual"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`allowly init needs --use-case ${SETUP_TEMPLATE_NAMES.join("|")} or --manual in non-interactive shells`);
  }

  const choices: Array<{ label: string; value: SetupTemplateName | "manual"; description: string }> = [
    ...SETUP_TEMPLATE_NAMES.map((name) => ({
      label: SETUP_TEMPLATE_LABELS[name],
      value: name,
      description: SETUP_TEMPLATE_DESCRIPTIONS[name],
    })),
    { label: "I'll set it up myself", value: "manual", description: "Start empty and configure actions and policies yourself." },
  ];

  console.log("Choose a use case to seed, or start empty:");
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label} - ${choice.description}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(`Choose 1-${choices.length}: `)).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) {
        return choices[index].value;
      }
      console.log(`Choose 1-${choices.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function commandInit(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.includes("--list-use-cases")) {
    listUseCases();
    return;
  }
  if (args.includes("--manual") || args.includes("--self")) {
    printManualNextSteps();
    return;
  }
  const selected = option(args, "--use-case") ?? (await promptSetupChoice());
  if (selected === "manual") {
    printManualNextSteps();
    return;
  }
  const useCaseName = SETUP_TEMPLATE_ALIASES[selected] ?? selected;
  if (!isSetupTemplateName(useCaseName)) {
    throw new Error(`Unknown setup use case "${useCaseName}". Use one of: ${SETUP_TEMPLATE_NAMES.join(", ")}`);
  }
  const file = option(args, "--file") ?? "allowly.setup.json";
  try {
    await writeSampleSetupConfig(file, getSetupTemplate(useCaseName));
    console.log(`Created ${file} from ${useCaseName} use-case seed`);
    printApplyNextSteps(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      console.log(`${file} already exists`);
      return;
    }
    throw err;
  }
}

async function commandActionsApply(file: string | undefined): Promise<void> {
  if (!file) throw new Error("Missing setup config path");
  const config = await readConfig();
  const setup = await loadSetupConfig(resolve(file));
  const existing = await listAll<{ name: string }>(config, "/v1/setup/actions");
  const existingNames = new Set(existing.map((action) => action.name));

  // Apply is intentionally idempotent: create missing resources, skip matches,
  // and never delete remote state unless a future explicit --prune is added.
  for (const action of setup.actions) {
    if (existingNames.has(action.name)) {
      console.log(`skip action ${action.name}`);
      continue;
    }
    await apiRequest(config, "POST", "/v1/setup/actions", {
      name: action.name,
      description: action.description,
      requires_confirm: action.requires_confirm ?? false,
      requires_escalation: action.requires_escalation ?? false,
      escalation_to: action.escalation_to,
      constraints_schema: action.constraints_schema ?? {},
    });
    console.log(`created action ${action.name}`);
  }
}

async function commandPoliciesApply(file: string | undefined): Promise<void> {
  if (!file) throw new Error("Missing setup config path");
  const config = await readConfig();
  const setup = await loadSetupConfig(resolve(file));
  const actions = await listAll<{ name: string }>(config, "/v1/setup/actions");
  const remoteActionNames = new Set(actions.map((action) => action.name));
  for (const policy of setup.policies) {
    const missing = policy.actions.map((action) => action.name).filter((name) => !remoteActionNames.has(name));
    if (missing.length) {
      throw new Error(`policy ${policy.policy_id} references missing actions: ${missing.join(", ")}. Run allowly actions apply first.`);
    }
  }

  const existing = await listAll<{ policy_id?: string }>(config, "/v1/setup/policies");
  const existingIds = new Set(
    existing
      .map((policy) => policy.policy_id)
      .filter((policyId): policyId is string => Boolean(policyId)),
  );
  for (const policy of setup.policies) {
    if (existingIds.has(policy.policy_id)) {
      console.log(`skip policy ${policy.policy_id}`);
      continue;
    }
    await apiRequest(config, "POST", "/v1/setup/policies", {
      policy_id: policy.policy_id,
      agent_id: policy.agent_id,
      description: policy.description,
      actions: policy.actions.map((action) => ({ name: action.name, constraints: action.constraints ?? {} })),
      requires_confirm_for: policy.requires_confirm_for ?? [],
      requires_escalation_for: policy.requires_escalation_for ?? [],
      requires_deny_for: policy.requires_deny_for ?? [],
      escalation_targets: policy.escalation_targets ?? {},
      default_expiry_days: policy.default_expiry_days,
    });
    console.log(`created policy ${policy.policy_id}`);
  }
}

async function upsertEnvVar(path: string, name: string, value: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split(/\r?\n/).filter(Boolean);
  const nextLine = `${name}=${value}`;
  const replaced = lines.map((line) => line.startsWith(`${name}=`) ? nextLine : line);
  if (!lines.some((line) => line.startsWith(`${name}=`))) replaced.push(nextLine);
  await writeFile(path, replaced.join("\n") + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readRuntimeKeyFromEnvFile(path: string, envVar: string): Promise<string | undefined> {
  try {
    const values = parseEnvFile(await readFile(path, "utf8"));
    return values[envVar];
  } catch {
    return undefined;
  }
}

async function runtimeConfigFromArgs(args: string[]): Promise<RuntimeConfig> {
  const setupConfig = await readConfig();
  const apiUrl = option(args, "--api-url") ?? setupConfig.apiUrl;
  const envVar = option(args, "--var") ?? "ALLOWLY_API_KEY";
  const runtimeEnv = option(args, "--runtime-env") ?? option(args, "--env-file");
  const accessToken = option(args, "--api-key")
    ?? (runtimeEnv ? await readRuntimeKeyFromEnvFile(runtimeEnv, envVar) : undefined)
    ?? process.env[envVar];
  if (!accessToken) {
    throw new Error(`Missing runtime API key. Pass --api-key, set ${envVar}, or use --runtime-env .env.local.`);
  }
  return { apiUrl, accessToken };
}

async function commandCheck(args: string[]): Promise<void> {
  const authorizationId = option(args, "--authorization-id");
  const actions = [...options(args, "--action"), ...(option(args, "--actions") ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  if (!authorizationId) throw new Error("Missing --authorization-id");
  if (actions.length === 0) throw new Error("Missing --action");
  const resource = option(args, "--resource");
  const sessionId = option(args, "--session-id");
  const contextRaw = option(args, "--context");
  const context = contextRaw ? JSON.parse(contextRaw) as Record<string, unknown> : {};
  const config = await runtimeConfigFromArgs(args);
  const result = await apiRequest<Record<string, unknown>>(
    config,
    "POST",
    `/v1/check${args.includes("--wait") ? "?wait=true" : ""}`,
    {
      authorization_id: authorizationId,
      actions,
      ...(resource ? { resource } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      context,
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

async function commandKeysCreate(args: string[]): Promise<void> {
  const config = await readConfig();
  const envFile = option(args, "--write-env") ?? option(args, "--env-output") ?? option(args, "--env-file");
  const envVar = option(args, "--var") ?? "ALLOWLY_API_KEY";
  const created = await apiRequest<RuntimeKeyResponse>(config, "POST", "/v1/setup/runtime-keys", {});

  // Runtime keys are shown once. Prefer writing them to local env files or a
  // secret manager; do not paste them into tickets, logs, or chat transcripts.
  if (envFile) {
    await upsertEnvVar(envFile, envVar, created.key);
    console.log(`Wrote ${envVar} to ${envFile}`);
    console.log(`Runtime API key created (${created.prefix}). It was not printed because it was written to disk.`);
    return;
  }
  console.log(`Runtime API key created (${created.prefix}). Store it now; it is shown once.`);
  console.log(`${envVar}=${created.key}`);
}

async function main(argv: string[]): Promise<void> {
  const [command, subcommand, action, fileOrArg, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "help") {
    console.log(usage());
    return;
  }
  if (command === "login") return commandLogin(argv.slice(1));
  if (command === "logout") return commandLogout();
  if (command === "status") return commandStatus();
  if (command === "init") return commandInit(argv.slice(1));
  if (command === "setup" && subcommand === "guide") return commandSetupGuide();
  if (command === "actions" && subcommand === "apply") return commandActionsApply(action);
  if (command === "policies" && subcommand === "apply") return commandPoliciesApply(action);
  if (command === "keys" && subcommand === "create") return commandKeysCreate([action, fileOrArg, ...rest].filter(Boolean));
  if (command === "check") return commandCheck(argv.slice(1));
  throw new Error(`Unknown command.\n\n${usage()}`);
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof AllowlyCliError) {
    console.error(`Allowly API error${err.code ? ` (${err.code})` : ""}: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
