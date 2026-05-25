#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_API_URL, readConfig, writeConfig } from "./config.js";
import { AllowlyCliError, apiRequest } from "./http.js";
import {
  SETUP_TEMPLATE_DESCRIPTIONS,
  SETUP_TEMPLATE_NAMES,
  getSetupTemplate,
  isSetupTemplateName,
  loadSetupConfig,
  writeSampleSetupConfig,
  type SetupTemplateName,
} from "./setupConfig.js";

interface ScopeResponse {
  items: Array<{ id: string; name: string }>;
}

interface BundleResponse {
  items: Array<{ id: string }>;
}

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
  workspace_id: string;
  workspace_name: string;
}

function usage(): string {
  return `Allowly CLI

Allowly is API-first after account, email, and billing setup.
Run allowly login once, approve the CLI in your browser, then let Codex,
Claude Code, or a script configure scopes, agent scope bundles, and runtime API keys
without dashboard or billing access.

Commands:
  allowly login [--api-url <url>] [--no-browser]
  allowly status
  allowly init [--use-case email-agent|browser-agent|client-intelligence] [--file allowly.setup.json]
  allowly init --list-use-cases
  allowly init --manual
  allowly init --ai
  allowly scopes apply <allowly.setup.json>
  allowly bundles apply <allowly.setup.json>
  allowly keys create [--write-env .env.local] [--var ALLOWLY_API_KEY]
  allowly setup guide
  allowly check --consent-id <id> --scope <scope> [--resource <resource>] [--runtime-env .env.local]

Optional use-case seeds:
${SETUP_TEMPLATE_NAMES.map((name) => `  ${name.padEnd(20)} ${SETUP_TEMPLATE_DESCRIPTIONS[name]}`).join("\n")}

Typical agent flow:
  allowly login --api-url https://api.allowly.ai
  allowly init
  allowly scopes apply allowly.setup.json
  allowly bundles apply allowly.setup.json
  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY

Runtime check flow:
  allowly check --consent-id cns_... --scope web.search --resource user:123 --runtime-env .env.local
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
  const data = text ? JSON.parse(text) as T & { error?: { code?: string; message?: string } } : ({} as T);
  if (!response.ok && response.status !== 202) {
    const errorBody = data as { error?: { code?: string; message?: string } };
    const message = errorBody.error?.message ?? `Allowly API returned ${response.status}`;
    const code = errorBody.error?.code ?? "error";
    throw new AllowlyCliError(message, response.status, code);
  }
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
  const apiUrl = option(args, "--api-url") ?? DEFAULT_API_URL;
  if (setupToken) {
    await writeConfig({ apiUrl, accessToken: setupToken });
    console.log(`Allowly CLI configured for ${apiUrl.replace(/\/$/, "")}`);
    console.log("Manual setup-token login is supported for advanced flows; normal setup should use `allowly login`.");
    return;
  }

  const started = await requestJson<DeviceStartResponse>(apiUrl, "/v1/cli/device/start", {});
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
      apiUrl,
      "/v1/cli/device/token",
      { device_code: device.device_code },
    );
    if (tokenResponse.status === 202 || tokenResponse.data.status === "pending") {
      const pending = tokenResponse.data as { status: "pending"; interval?: number };
      pollIntervalMs = Math.max(1, pending.interval ?? device.interval ?? 3) * 1000;
      continue;
    }
    const authorized = tokenResponse.data as DeviceTokenResponse;
    await writeConfig({
      apiUrl,
      accessToken: authorized.access_token,
      expiresAt: authorized.expires_at,
      workspaceId: authorized.workspace_id,
      workspaceName: authorized.workspace_name,
    });
    console.log(`Allowly CLI configured for ${authorized.workspace_name} (${apiUrl.replace(/\/$/, "")})`);
    return;
  }
  throw new AllowlyCliError("CLI login code expired. Run `allowly login` again.", 401, "authorization_expired");
}

async function commandStatus(): Promise<void> {
  const config = await readConfig();
  const status = await apiRequest<Record<string, unknown>>(config, "GET", "/v1/setup/status");
  console.log(JSON.stringify(status, null, 2));
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
1. Define scopes: individual permissions like web.search or lead.enrich.
2. Define agent scope bundles: reusable groups of scopes per agent/use case.
3. Create a runtime API key and store it in your app env or secret manager.
4. Your app creates consents from bundle IDs and calls /v1/check before acting.

Setup file format:
{
  "scopes": [
    {
      "name": "web.search",
      "description": "Search the public web.",
      "requires_confirm": false,
      "constraints_schema": {}
    }
  ],
  "agent_scope_bundles": [
    {
      "id": "marketing_user_enrichment",
      "agent_id": "marketing_user_enrichment",
      "description": "Enriches users with public marketing context.",
      "scopes": [
        { "name": "web.search" }
      ],
      "requires_confirm_for": [],
      "default_expiry_days": 90
    }
  ]
}

Apply:
  allowly scopes apply allowly.setup.json
  allowly bundles apply allowly.setup.json
  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY

Runtime check:
  allowly check --consent-id cns_... --scope web.search --resource user:123 --runtime-env .env.local

Security boundary:
- setup/login credentials configure scopes, bundles, and runtime keys.
- runtime API keys create consents and call /v1/check.
- the CLI does not sign receipts; the Allowly API signs receipts server-side.`);
}

function listUseCases(): void {
  for (const name of SETUP_TEMPLATE_NAMES) {
    console.log(`${name}: ${SETUP_TEMPLATE_DESCRIPTIONS[name]}`);
  }
  console.log("manual: I'll set it up myself");
  console.log("ai: AI-customized use-case seeds are coming soon");
}

function printApplyNextSteps(file: string): void {
  console.log("Review it, then run:");
  console.log(`  allowly scopes apply ${file}`);
  console.log(`  allowly bundles apply ${file}`);
  console.log("  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY");
  console.log("AI customization is coming soon.");
}

function printManualNextSteps(): void {
  console.log("Manual setup selected. No setup file was created and no workspace resources were changed.");
  console.log("Create your own allowly.setup.json, then run:");
  console.log("  allowly scopes apply allowly.setup.json");
  console.log("  allowly bundles apply allowly.setup.json");
  console.log("  allowly keys create --write-env .env.local --var ALLOWLY_API_KEY");
  console.log("Tip: use allowly init --list-use-cases to view optional use-case seeds.");
}

async function promptSetupChoice(): Promise<SetupTemplateName | "manual"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`allowly init needs --use-case ${SETUP_TEMPLATE_NAMES.join("|")} or --manual in non-interactive shells`);
  }

  const choices: Array<{ label: string; value: SetupTemplateName | "manual"; description: string }> = [
    { label: "Email assistant", value: "email-agent", description: SETUP_TEMPLATE_DESCRIPTIONS["email-agent"] },
    { label: "Browser automation", value: "browser-agent", description: SETUP_TEMPLATE_DESCRIPTIONS["browser-agent"] },
    { label: "Client intelligence", value: "client-intelligence", description: SETUP_TEMPLATE_DESCRIPTIONS["client-intelligence"] },
    { label: "I'll set it up myself", value: "manual", description: "Start empty and configure scopes/bundles yourself." },
  ];

  console.log("Choose a use case to seed, or start empty:");
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label} - ${choice.description}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question("Choose 1-4: ")).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) {
        return choices[index].value;
      }
      console.log("Choose 1, 2, 3, or 4.");
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
  if (args.includes("--ai")) {
    console.log("AI-customized setup seeds are coming soon. Use allowly init to choose a use case for now.");
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
  const useCaseName = selected;
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

async function commandScopesApply(file: string | undefined): Promise<void> {
  if (!file) throw new Error("Missing setup config path");
  const config = await readConfig();
  const setup = await loadSetupConfig(resolve(file));
  const existing = await apiRequest<ScopeResponse>(config, "GET", "/v1/setup/scopes");
  const existingNames = new Set(existing.items.map((scope) => scope.name));

  // Apply is intentionally idempotent: create missing resources, skip matches,
  // and never delete remote state unless a future explicit --prune is added.
  for (const scope of setup.scopes) {
    if (existingNames.has(scope.name)) {
      console.log(`skip scope ${scope.name}`);
      continue;
    }
    await apiRequest(config, "POST", "/v1/setup/scopes", {
      name: scope.name,
      description: scope.description,
      requires_confirm: scope.requires_confirm ?? false,
      constraints_schema: scope.constraints_schema ?? {},
    });
    console.log(`created scope ${scope.name}`);
  }
}

async function commandBundlesApply(file: string | undefined): Promise<void> {
  if (!file) throw new Error("Missing setup config path");
  const config = await readConfig();
  const setup = await loadSetupConfig(resolve(file));
  const scopes = await apiRequest<ScopeResponse>(config, "GET", "/v1/setup/scopes");
  const remoteScopeNames = new Set(scopes.items.map((scope) => scope.name));
  for (const bundle of setup.agent_scope_bundles) {
    const missing = bundle.scopes.map((scope) => scope.name).filter((name) => !remoteScopeNames.has(name));
    if (missing.length) {
      throw new Error(`agent scope bundle ${bundle.id} references missing scopes: ${missing.join(", ")}. Run allowly scopes apply first.`);
    }
  }

  const existing = await apiRequest<BundleResponse>(config, "GET", "/v1/setup/agent-scope-bundles");
  const existingIds = new Set(existing.items.map((bundle) => bundle.id));
  for (const bundle of setup.agent_scope_bundles) {
    if (existingIds.has(bundle.id)) {
      console.log(`skip agent scope bundle ${bundle.id}`);
      continue;
    }
    await apiRequest(config, "POST", "/v1/setup/agent-scope-bundles", {
      id: bundle.id,
      agent_id: bundle.agent_id,
      description: bundle.description,
      scopes: bundle.scopes.map((scope) => ({ name: scope.name, constraints: scope.constraints ?? {} })),
      requires_confirm_for: bundle.requires_confirm_for ?? [],
      default_expiry_days: bundle.default_expiry_days,
    });
    console.log(`created agent scope bundle ${bundle.id}`);
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
  const consentId = option(args, "--consent-id");
  const scopes = [...options(args, "--scope"), ...(option(args, "--scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  if (!consentId) throw new Error("Missing --consent-id");
  if (scopes.length === 0) throw new Error("Missing --scope");
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
      consent_id: consentId,
      scopes,
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
  if (command === "status") return commandStatus();
  if (command === "init") return commandInit(argv.slice(1));
  if (command === "setup" && subcommand === "guide") return commandSetupGuide();
  if (command === "scopes" && subcommand === "apply") return commandScopesApply(action);
  if (command === "bundles" && subcommand === "apply") return commandBundlesApply(action);
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
