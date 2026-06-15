import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { SETUP_TEMPLATE_NAMES, getSetupTemplate, loadSetupConfig, writeSampleSetupConfig } from "./setupConfig.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeJson(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "allowly-setup-"));
  dirs.push(dir);
  const path = join(dir, "allowly.setup.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("loadSetupConfig accepts actions and policies", async () => {
  const path = await writeJson({
    actions: [
      { name: "email.read" },
      { name: "candidate.delete", requires_escalation: true, escalation_to: "compliance" },
      { name: "record.delete", requires_deny: true },
    ],
    policies: [
      {
        policy_id: "basic",
        agent_id: "agent",
        actions: [{ name: "email.read" }, { name: "candidate.delete" }, { name: "record.delete" }],
        requires_escalation_for: ["candidate.delete"],
        requires_deny_for: ["record.delete"],
        escalation_targets: { "candidate.delete": "compliance" },
      },
    ],
  });

  await expect(loadSetupConfig(path)).resolves.toMatchObject({
    actions: [
      { name: "email.read" },
      { name: "candidate.delete", requires_escalation: true, escalation_to: "compliance" },
      { name: "record.delete", requires_deny: true },
    ],
    policies: [
      {
        policy_id: "basic",
        agent_id: "agent",
        requires_escalation_for: ["candidate.delete"],
        requires_deny_for: ["record.delete"],
        escalation_targets: { "candidate.delete": "compliance" },
      },
    ],
  });
});

test("loadSetupConfig rejects policies without actions", async () => {
  const path = await writeJson({
    actions: [{ name: "email.read" }],
    policies: [{ policy_id: "basic", agent_id: "agent", actions: [] }],
  });

  await expect(loadSetupConfig(path)).rejects.toThrow("must include at least one action");
});

test("starter policies are valid setup configs", async () => {
  for (const useCaseName of SETUP_TEMPLATE_NAMES) {
    const dir = await mkdtemp(join(tmpdir(), "allowly-policy-"));
    dirs.push(dir);
    const path = join(dir, "allowly.setup.json");
    await writeSampleSetupConfig(path, getSetupTemplate(useCaseName));

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.actions.length).toBeGreaterThan(0);
    expect(written.policies.length).toBeGreaterThan(0);
    await expect(loadSetupConfig(path)).resolves.toMatchObject(written);
  }
});

test("starter policies include client intelligence, hiring, MCP, and no-code", () => {
  expect(SETUP_TEMPLATE_NAMES).toEqual([
    "email-agent",
    "browser-agent",
    "client-intelligence",
    "hr-ops",
    "mcp-guardrails",
    "no-code-automation",
  ]);

  const seed = getSetupTemplate("client-intelligence");
  expect(seed.actions.map((action) => action.name)).toEqual([
    "web.search",
    "web.page.read",
    "contact.profile.read",
    "crm.account.read",
    "lead.enrich",
    "email.draft",
    "email.send",
  ]);
  expect(seed.policies[0].requires_confirm_for).toEqual(["lead.enrich", "email.send"]);
});

test("generated browser policy confirms clicks and denies form submits", () => {
  const seed = getSetupTemplate("browser-agent");
  const policy = seed.policies[0];

  expect(policy.requires_confirm_for).toEqual(["browser.click"]);
  expect(policy.requires_deny_for).toEqual(["browser.form.submit"]);
  expect(policy.default_expiry_days).toBe(365);
});

test("hr-ops template escalates candidate rejection", () => {
  const seed = getSetupTemplate("hr-ops");
  const policy = seed.policies[0];

  expect(seed.actions.map((action) => action.name)).toEqual([
    "candidate.profile.read",
    "candidate.score.update",
    "candidate.reject",
    "candidate.outreach.send",
  ]);
  expect(policy.requires_confirm_for).toEqual(["candidate.score.update", "candidate.outreach.send"]);
  expect(policy.requires_escalation_for).toEqual(["candidate.reject"]);
  expect(policy.escalation_targets?.["candidate.reject"]).toBe("hr_approver");
});

test("mcp-guardrails template escalates sensitive tool calls", () => {
  const seed = getSetupTemplate("mcp-guardrails");
  const policy = seed.policies[0];

  expect(seed.actions.map((action) => action.name)).toEqual([
    "mcp.tool.read",
    "mcp.tool.call",
    "mcp.tool.call.sensitive",
  ]);
  expect(policy.requires_confirm_for).toEqual(["mcp.tool.call"]);
  expect(policy.requires_escalation_for).toEqual(["mcp.tool.call.sensitive"]);
  expect(policy.escalation_targets?.["mcp.tool.call.sensitive"]).toBe("security_approver");
});

test("no-code-automation generated policy denies irreversible workflow steps", () => {
  const seed = getSetupTemplate("no-code-automation");
  const policy = seed.policies[0];

  expect(policy.requires_confirm_for).toEqual(["workflow.record.update", "workflow.message.send"]);
  expect(policy.requires_deny_for).toEqual(["workflow.irreversible.execute"]);
});
