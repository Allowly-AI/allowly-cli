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

test("loadSetupConfig accepts scopes and agent scope bundles", async () => {
  const path = await writeJson({
    scopes: [
      { name: "email.read" },
      { name: "candidate.delete", requires_escalation: true, escalation_to: "compliance" },
    ],
    agent_scope_bundles: [
      {
        id: "basic",
        agent_id: "agent",
        scopes: [{ name: "email.read" }, { name: "candidate.delete" }],
        requires_escalation_for: ["candidate.delete"],
        escalation_targets: { "candidate.delete": "compliance" },
      },
    ],
  });

  await expect(loadSetupConfig(path)).resolves.toMatchObject({
    scopes: [
      { name: "email.read" },
      { name: "candidate.delete", requires_escalation: true, escalation_to: "compliance" },
    ],
    agent_scope_bundles: [
      {
        id: "basic",
        agent_id: "agent",
        requires_escalation_for: ["candidate.delete"],
        escalation_targets: { "candidate.delete": "compliance" },
      },
    ],
  });
});

test("loadSetupConfig rejects bundles without scopes", async () => {
  const path = await writeJson({
    scopes: [{ name: "email.read" }],
    agent_scope_bundles: [{ id: "basic", agent_id: "agent", scopes: [] }],
  });

  await expect(loadSetupConfig(path)).rejects.toThrow("must include at least one scope");
});

test("starter bundles are valid setup configs", async () => {
  for (const useCaseName of SETUP_TEMPLATE_NAMES) {
    const dir = await mkdtemp(join(tmpdir(), "allowly-bundle-"));
    dirs.push(dir);
    const path = join(dir, "allowly.setup.json");
    await writeSampleSetupConfig(path, getSetupTemplate(useCaseName));

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.scopes.length).toBeGreaterThan(0);
    expect(written.agent_scope_bundles.length).toBeGreaterThan(0);
    await expect(loadSetupConfig(path)).resolves.toMatchObject(written);
  }
});

test("starter bundles include client intelligence, hiring, MCP, and no-code", () => {
  expect(SETUP_TEMPLATE_NAMES).toEqual([
    "email-agent",
    "browser-agent",
    "client-intelligence",
    "hiring-disposition",
    "mcp-tool-gating",
    "no-code-automation",
  ]);

  const seed = getSetupTemplate("client-intelligence");
  expect(seed.scopes.map((scope) => scope.name)).toEqual([
    "web.search",
    "web.page.read",
    "contact.profile.read",
    "crm.account.read",
    "lead.enrich",
    "email.draft",
    "email.send",
  ]);
  expect(seed.agent_scope_bundles[0].requires_confirm_for).toEqual(["lead.enrich", "email.send"]);
});

test("mcp-tool-gating template covers read / write / destructive MCP tools", () => {
  const seed = getSetupTemplate("mcp-tool-gating");
  const bundle = seed.agent_scope_bundles[0];

  expect(bundle.requires_escalation_for).toEqual([
    "github.repo.delete",
    "slack.channel.archive",
    "drive.file.delete",
    "secret.rotate",
  ]);

  const slackSend = bundle.scopes.find((scope) => scope.name === "slack.message.send");
  const constraints = (slackSend?.constraints ?? {}) as Record<string, unknown>;
  const confirmWhen = constraints.confirm_when as Array<Record<string, unknown>>;
  expect(confirmWhen).toContainEqual({ field: "channel_visibility", eq: "public" });
});

test("no-code-automation template demonstrates conditional routing on email.send", () => {
  const seed = getSetupTemplate("no-code-automation");
  const bundle = seed.agent_scope_bundles[0];
  const emailSend = bundle.scopes.find((scope) => scope.name === "email.send");
  const constraints = (emailSend?.constraints ?? {}) as Record<string, unknown>;
  const confirmWhen = constraints.confirm_when as Array<Record<string, unknown>>;
  const escalateWhen = constraints.escalate_when as Array<Record<string, unknown>>;

  expect(confirmWhen).toContainEqual({ field: "recipient_count", gte: 100 });
  expect(confirmWhen).toContainEqual({ field: "prospect_region", in: ["EU", "UK"] });
  expect(escalateWhen).toContainEqual({ field: "domain_suppression_match", eq: true });
});

test("hiring-disposition template demonstrates confirm_when and escalate_when", () => {
  const seed = getSetupTemplate("hiring-disposition");
  expect(seed.scopes.map((scope) => scope.name)).toEqual([
    "hiring.synthesize_feedback",
    "hiring.recommend_disposition",
  ]);

  const bundle = seed.agent_scope_bundles[0];
  const recommend = bundle.scopes.find((scope) => scope.name === "hiring.recommend_disposition");
  const constraints = (recommend?.constraints ?? {}) as Record<string, unknown>;
  const confirmWhen = constraints.confirm_when as Array<Record<string, unknown>>;
  const escalateWhen = constraints.escalate_when as Array<Record<string, unknown>>;

  expect(confirmWhen[0]).toEqual({ field: "decision_recommended", eq: "reject" });
  expect(escalateWhen[0]).toEqual({ field: "rule_fired", in: ["demographic_proxy"] });
  expect(bundle.escalation_targets?.["hiring.recommend_disposition"]).toBe("compliance@example.com");
});
