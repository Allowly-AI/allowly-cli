import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSealValue } from "@allowly/sdk";
import { afterEach, expect, test, vi } from "vitest";
import { writeConfig } from "./config.js";
import { applyPolicies, previewPolicy, publishPolicy } from "./policyCommands.js";
import { getSetupTemplate, loadPolicyConfig, loadPolicyConfigs, loadSetupConfig, policyDefinition,
  setupConfigFromPolicyDraft, writeSampleSetupConfig, type PolicyConfig } from "./setupConfig.js";

const dirs: string[] = [];
const originalArgv = process.argv, originalExitCode = process.exitCode;
const config = { apiUrl: "https://api.allowly.test", accessToken: "setup-secret" };
afterEach(async () => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "allowly-policy-evidence-")); dirs.push(dir); return dir;
}
function evidencePolicy(): PolicyConfig {
  const value = getSetupTemplate("email-agent").policies[0];
  const entry = value.actions[0];
  value.actions = [entry];
  entry.policy.fields = { sensitive: "boolean", external: "boolean", restricted: "boolean", domain: "string" };
  entry.policy.rules = [{ id: "restricted", decision: "deny", target: null,
    conditions: [{ field: "restricted", op: "eq", value: true }] }];
  entry.evidence = {
    sensitive: { sources: ["body"], instruction: "Identify sensitive content in the message." },
    external: { sources: ["to"], instruction: "Identify recipients outside example.test." },
    restricted: { all_of: ["sensitive", "external"] },
    domain: { source: "to", transform: "email_domain", empty_sources: ["cc", "bcc"] },
  };
  return value;
}
function draft(value: PolicyConfig) {
  return { policy_id: value.policy_id, description: value.description!,
    definition: { profile: value.profile, agent_id: value.agent_id, actions: value.actions, default_expiry_days: value.default_expiry_days },
    action_definitions: value.actions.map(entry => ({ name: entry.policy.action, description: "Observe this action." })) };
}
function response(value: PolicyConfig) {
  const definition = policyDefinition(value);
  return { policy_ref: { policy_id: value.policy_id, policy_version: 1, definition_sha256: hashSealValue(definition) },
    definition, description: value.description, created_by: "member:owner", created_at: "2026-10-18T00:00:00Z", deleted_at: null };
}

test("retains every approved evidence form through flat/setup files and AI draft conversion", async () => {
  const value = evidencePolicy(), dir = await directory();
  const standalone = join(dir, "policy.json"), setup = join(dir, "setup.json"), ai = join(dir, "ai.json");
  const converted = setupConfigFromPolicyDraft(draft(value));
  await writeFile(standalone, JSON.stringify(value));
  await writeFile(setup, JSON.stringify(converted));
  await writeSampleSetupConfig(ai, converted);
  expect(converted.policies).toEqual([value]);
  expect(await loadPolicyConfig(standalone)).toEqual(value);
  for (const path of [standalone, setup, ai]) expect(await loadPolicyConfigs(path)).toEqual([value]);
  expect(await loadSetupConfig(setup)).toEqual(converted);
  expect(JSON.parse(await readFile(ai, "utf8"))).toEqual(converted);
});

test("ordinary definitions retain their original registry SDK digest without adding evidence", () => {
  const definition = policyDefinition(getSetupTemplate("email-agent").policies[0]);
  expect(hashSealValue(definition)).toBe("86b2f73ed9ecbaf8ed0734aca707039af05e3740c0d7bd853e8b6c6f419bb0f3");
  for (const entry of definition.actions) expect(entry).not.toHaveProperty("evidence");
});

test.each([
  null,
  {},
  { sensitive: { sources: ["body"], instruction: "Missing other declared fields." } },
  { sensitive: { sources: ["body"], instruction: "Check content." }, external: { sources: ["to"], instruction: "Check recipient." },
    restricted: { all_of: ["domain"] }, domain: { source: "to", transform: "email_domain", empty_sources: [] } },
])("rejects malformed evidence in local files and AI drafts %#", async evidence => {
  const value = evidencePolicy(); (value.actions[0] as any).evidence = evidence;
  const path = join(await directory(), "policy.json"); await writeFile(path, JSON.stringify(value));
  await expect(loadPolicyConfig(path)).rejects.toThrow();
  expect(() => setupConfigFromPolicyDraft(draft(value))).toThrow();
});

test.each(["apply", "preview", "publish"])("%s sends the complete approved evidence through the real SDK", async command => {
  const value = evidencePolicy(), retained = response(value), action = value.actions[0].policy.action, context = {};
  const evaluation = { input_sha256: hashSealValue({ policy: value.actions[0].policy, action, context }),
    result: { profile: "allowly.basic.v1", status: "ok", decision: "allow", target: null, matched_rule_id: null, evaluated_fields: {} } };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/v1/policies?")) return new Response(JSON.stringify({ items: [], has_more: false, next_cursor: null }));
    if (command === "preview") return new Response(JSON.stringify({ provisional: true, definition_sha256: retained.policy_ref.definition_sha256, action, policy_eval: evaluation }));
    if (command === "publish") return new Response(JSON.stringify({ policy_ref: retained.policy_ref, agent_id: value.agent_id,
      created_by: retained.created_by, created_at: retained.created_at, authorization_migrations: [], archived_policy_ids: [], revoked_confirmation_count: 0 }), { status: 201 });
    return new Response(JSON.stringify(retained), { status: 201 });
  });
  vi.stubGlobal("fetch", fetch); vi.spyOn(console, "log").mockImplementation(() => {});
  if (command === "apply") await applyPolicies(config, [value]);
  else if (command === "preview") expect((await previewPolicy(config, value, action, context)).definitionSha256).toBe(retained.policy_ref.definition_sha256);
  else expect((await publishPolicy(config, value, "evidence-edition-1")).policyRef).toEqual(retained.policy_ref);
  expect(fetch).toHaveBeenCalledTimes(command === "apply" ? 2 : 1);
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  expect(JSON.parse(String(call[1]?.body))).toEqual(command === "preview" ? { definition: retained.definition, action, context } : value);
  if (command === "publish") expect((call[1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("evidence-edition-1");
});

test("apply skips identical evidence but requires an exact predecessor after an instruction-only edit", async () => {
  const value = evidencePolicy(), retained = response(value);
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ items: [retained], has_more: false, next_cursor: null })));
  vi.stubGlobal("fetch", fetch); vi.spyOn(console, "log").mockImplementation(() => {});
  await applyPolicies(config, [value]); expect(fetch).toHaveBeenCalledTimes(1);
  value.actions[0].evidence!.sensitive = { sources: ["body"], instruction: "A changed approved extraction instruction." };
  expect(hashSealValue(policyDefinition(value))).not.toBe(retained.policy_ref.definition_sha256);
  await expect(applyPolicies(config, [value])).rejects.toThrow("exact previous_policy_ref");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  ["apply", []],
  ["preview", ["--action", "email.read", "--context", "{}"]],
  ["publish", ["--idempotency-key", "invalid-evidence"]],
])("policies %s rejects malformed evidence before any outbound request", async (command, args) => {
  const dir = await directory(); vi.stubEnv("ALLOWLY_CONFIG_DIR", dir); await writeConfig(config);
  const value = evidencePolicy(); (value.actions[0] as any).evidence = null;
  const path = join(dir, "policy.json"); await writeFile(path, JSON.stringify(value));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [process.execPath, "allowly", "policies", command, path, ...args];
  await import("./index.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(process.exitCode).toBe(1); expect(fetch).not.toHaveBeenCalled();
});
