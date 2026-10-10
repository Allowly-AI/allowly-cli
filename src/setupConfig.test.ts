import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SETUP_TEMPLATE_ALIASES, SETUP_TEMPLATE_NAMES, getSetupTemplate, loadSetupConfig,
  loadPolicyConfigs, parsePolicyConfig, setupConfigFromPolicyDraft, writeSampleSetupConfig } from "./setupConfig.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function writeJson(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "allowly-setup-")); dirs.push(dir);
  const path = join(dir, "allowly.setup.json"); await writeFile(path, JSON.stringify(value)); return path;
}
test("all starter policies contain fresh complete definitions and valid catalog descriptions", async () => {
  for (const name of SETUP_TEMPLATE_NAMES) {
    const seed = getSetupTemplate(name), path = await writeJson(seed);
    expect(await loadSetupConfig(path)).toEqual(seed);
    expect(seed.policies[0].profile).toBe("allowly.policy.v1");
    for (const action of seed.policies[0].actions) {
      expect(action.policy.profile).toBe("allowly.basic.v1");
      expect(action).toHaveProperty("guards"); expect(action).toHaveProperty("executable_operations");
      expect(Object.values(action.policy.fields).every(type => ["string", "integer", "boolean", "null"].includes(type))).toBe(true);
    }
    expect(JSON.stringify(seed)).not.toMatch(/requires_|constraints|security_approver/);
  }
});
test("a standalone flat policy file is accepted without a definition wrapper", async () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  expect(await loadPolicyConfigs(await writeJson(policy))).toEqual([policy]);
  expect(await loadPolicyConfigs(await writeJson(getSetupTemplate("email-agent")))).toEqual([policy]);
});
test.each(["requires_confirm_for", "requires_escalation_for", "requires_deny_for", "escalation_targets", "definition"])("rejects old/wrapped policy authority %s", key => {
  expect(() => parsePolicyConfig({ ...getSetupTemplate("email-agent").policies[0], [key]: [] })).toThrow("unknown fields");
});
test.each(["requires_confirm", "requires_escalation", "constraints_schema"])("catalog fields cannot carry decision authority: %s", async key => {
  const seed = getSetupTemplate("email-agent") as any; seed.actions[0][key] = true;
  await expect(loadSetupConfig(await writeJson(seed))).rejects.toThrow("names/descriptions only");
});
test("requires full BasicPolicy instead of inline name/constraints", () => {
  const value = { ...getSetupTemplate("email-agent").policies[0], actions: [{ name: "email.read", constraints: {} }] };
  expect(() => parsePolicyConfig(value)).toThrow();
});
test("AI drafts retain the complete definition and ordered rules rather than translating flags", () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  const definition = { profile: policy.profile, agent_id: policy.agent_id, actions: policy.actions, default_expiry_days: policy.default_expiry_days };
  const result = setupConfigFromPolicyDraft({ policy_id: "email_review", description: "Review email", definition, action_definitions: [
    { name: "email.read", description: "Read email" }, { name: "email.send", description: "Send email" },
  ] });
  expect(result.policies[0]).toEqual({ ...definition, policy_id: "email_review", description: "Review email" });
  expect(() => setupConfigFromPolicyDraft({ ...definition, policy_id: "old", description: "Old", actions: [] } as any)).toThrow();
  expect(() => setupConfigFromPolicyDraft({ policy_id: "email_review", description: "Review email", definition, action_definitions: [{ name: "other", description: "Wrong" }] })).toThrow("exactly match");
});
test("successor references are exact and use strict positive safe edition numbers", () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  const reference = { policy_id: policy.policy_id, policy_version: 1, definition_sha256: "a".repeat(64) };
  expect(parsePolicyConfig({ ...policy, previous_policy_ref: reference }).previous_policy_ref).toEqual(reference);
  for (const version of [true, 0, -1, "1", 1.5, 2 ** 53]) expect(() => parsePolicyConfig({ ...policy, previous_policy_ref: { ...reference, policy_version: version } })).toThrow();
});
test("MCP sensitive seed fails closed without inventing reviewer IDs", () => {
  const policy = getSetupTemplate("mcp-guardrails").policies[0].actions.find(entry => entry.policy.action === "mcp.tool.call.sensitive")!.policy;
  expect(policy.default_decision).toBe("deny"); expect(policy.default_target).toBeNull();
});
test("browser and workflow seed safety defaults remain explicit", () => {
  expect(getSetupTemplate("browser-agent").policies[0].actions.map(entry => entry.policy.default_decision)).toEqual(["allow", "confirm", "deny"]);
  expect(getSetupTemplate("no-code-automation").policies[0].actions.map(entry => entry.policy.default_decision)).toEqual(["allow", "confirm", "confirm", "deny"]);
  expect(getSetupTemplate("hr-ops").policies[0].actions[1].policy.default_target).toBe("agent_owner");
  expect(SETUP_TEMPLATE_ALIASES["hiring-disposition"]).toBe("hr-ops");
});
test("writing a seed never overwrites an existing local file", async () => {
  const path = await writeJson({ original: true });
  await expect(writeSampleSetupConfig(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ original: true });
});
