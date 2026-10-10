import { readFile, writeFile } from "node:fs/promises";
import { parsePolicyReference, validatePolicyDefinition, type PolicyActionEntry, type PolicyDefinition, type PolicyReference } from "@allowly/sdk";

export interface ActionConfig { name: string; description?: string }
export type PolicyConfig = PolicyDefinition & {
  policy_id: string;
  description?: string;
  previous_policy_ref?: PolicyReference;
};
export interface AllowlySetupConfig { actions: ActionConfig[]; policies: PolicyConfig[] }
export interface PolicyDraft {
  policy_id: string;
  description: string;
  definition: PolicyDefinition;
  action_definitions: Array<{ name: string; description: string }>;
}
type SeedDecision = "allow" | "confirm" | "deny";
function entry(name: string, decision: SeedDecision, description: string, fields: PolicyActionEntry["policy"]["fields"] = {}) {
  return { description, definition: {
    policy: { profile: "allowly.basic.v1" as const, action: name, default_decision: decision,
      default_target: decision === "confirm" ? "agent_owner" : null, fields, rules: [] },
    guards: {}, executable_operations: [],
  } satisfies PolicyActionEntry };
}
const hiringFields: PolicyActionEntry["policy"]["fields"] = {
  outcome: "string", reviewer_id: "string", summary_grounded: "boolean",
  transcript_completeness: "integer", panel_feedback_complete: "boolean", candidate_ai_opt_out: "boolean",
};
const USE_CASE_SEEDS = {
  "email-agent": {
    label: "Email assistant", description: "Read email, with owner confirmation before sending.",
    entries: [entry("email.read", "allow", "Read user email."), entry("email.send", "confirm", "Send email on behalf of the user.")],
  },
  "browser-agent": {
    label: "Browser automation", description: "Read pages, confirm clicks, and deny form submissions.",
    entries: [entry("browser.read", "allow", "Read page content."), entry("browser.click", "confirm", "Click page controls."),
      entry("browser.form.submit", "deny", "Form submission stays blocked until explicitly configured.")],
  },
  "client-intelligence": {
    label: "Client intelligence", description: "Research contacts and confirm enrichment and outreach.",
    entries: [entry("web.search", "allow", "Search the public web."), entry("web.page.read", "allow", "Read public webpages."),
      entry("contact.profile.read", "allow", "Read contact context."), entry("crm.account.read", "allow", "Read CRM account context."),
      entry("lead.enrich", "confirm", "Write enriched intelligence."), entry("email.draft", "allow", "Draft outreach."),
      entry("email.send", "confirm", "Send outreach.")],
  },
  "hr-ops": {
    label: "HR and hiring", description: "Draft feedback; the agent owner confirms before it posts.",
    entries: [entry("hiring.synthesize_feedback", "allow", "Draft interview feedback.", hiringFields),
      entry("hiring.publish_feedback", "confirm", "Post reviewed feedback to the ATS.", hiringFields)],
  },
  "mcp-guardrails": {
    label: "MCP guardrails", description: "Confirm mutating tools; deny sensitive tools until a real member reviewer is configured.",
    entries: [entry("mcp.tool.read", "allow", "Read tool metadata."),
      entry("mcp.tool.call", "confirm", "Confirm mutating tool calls.", { tool_name: "string", estimated_cost_micros: "integer", resource: "string" }),
      entry("mcp.tool.call.sensitive", "deny", "Sensitive calls are blocked until a real member:<ID> target is configured.",
        { tool_name: "string", resource: "string", estimated_cost_micros: "integer", action_type: "string" })],
  },
  "no-code-automation": {
    label: "No-code automation", description: "Confirm writes and sends; deny irreversible workflow steps.",
    entries: [entry("workflow.record.read", "allow", "Read workflow records."),
      entry("workflow.record.update", "confirm", "Create or update records.", { platform: "string", resource: "string", estimated_cost_micros: "integer" }),
      entry("workflow.message.send", "confirm", "Send workflow messages.", { platform: "string", recipient_type: "string", template_name: "string" }),
      entry("workflow.irreversible.execute", "deny", "Irreversible steps stay blocked.", { platform: "string", action_type: "string", resource: "string" })],
  },
};
export type SetupTemplateName = keyof typeof USE_CASE_SEEDS;
export const SETUP_TEMPLATE_ALIASES: Record<string, SetupTemplateName> = { "hiring-disposition": "hr-ops" };
export const SETUP_TEMPLATE_NAMES = Object.keys(USE_CASE_SEEDS) as SetupTemplateName[];
export const SETUP_TEMPLATE_LABELS = Object.fromEntries(SETUP_TEMPLATE_NAMES.map(name => [name, USE_CASE_SEEDS[name].label])) as Record<SetupTemplateName, string>;
export const SETUP_TEMPLATE_DESCRIPTIONS = Object.fromEntries(SETUP_TEMPLATE_NAMES.map(name => [name, USE_CASE_SEEDS[name].description])) as Record<SetupTemplateName, string>;

export function getSetupTemplate(name: SetupTemplateName): AllowlySetupConfig {
  const seed = USE_CASE_SEEDS[name];
  return {
    actions: seed.entries.map(item => ({ name: item.definition.policy.action, description: item.description })),
    policies: [parsePolicyConfig({
      profile: "allowly.policy.v1", policy_id: `${name}-basic`, agent_id: name,
      description: seed.description, actions: seed.entries.map(item => item.definition), default_expiry_days: 365,
    })],
  };
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > limit) throw new Error(`${name} must be a bounded nonempty string`);
  return value;
}
export function policyDefinition(config: PolicyConfig): PolicyDefinition {
  return validatePolicyDefinition({ profile: config.profile, agent_id: config.agent_id,
    actions: config.actions, default_expiry_days: config.default_expiry_days });
}
export function parsePolicyConfig(value: unknown): PolicyConfig {
  const raw = object(value, "policy");
  const allowed = new Set(["profile", "agent_id", "actions", "default_expiry_days", "policy_id", "description", "previous_policy_ref"]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error("policy has unknown fields; legacy rule maps are not supported");
  const policyId = boundedText(raw.policy_id, "policy_id", 128);
  if (!/^[a-z0-9_-]+$/.test(policyId)) throw new Error("policy_id must use lowercase letters, digits, underscore or hyphen");
  if (raw.description !== undefined && (typeof raw.description !== "string" || [...raw.description].length > 2048)) throw new Error("description must be a bounded string");
  const definition = validatePolicyDefinition({ profile: raw.profile, agent_id: raw.agent_id, actions: raw.actions, default_expiry_days: raw.default_expiry_days });
  return { ...definition, policy_id: policyId,
    ...(raw.description === undefined ? {} : { description: raw.description as string }),
    ...(raw.previous_policy_ref === undefined ? {} : { previous_policy_ref: parsePolicyReference(raw.previous_policy_ref) }) };
}
function parseActions(value: unknown): ActionConfig[] {
  if (!Array.isArray(value)) throw new Error("setup config must include an actions array");
  return value.map(item => {
    const raw = object(item, "action catalog entry");
    if (Object.keys(raw).some(key => !["name", "description"].includes(key))) throw new Error("action catalog entries contain names/descriptions only, not decision flags");
    const name = boundedText(raw.name, "action name", 64);
    if (raw.description !== undefined && (typeof raw.description !== "string" || [...raw.description].length > 512)) throw new Error("action description must be bounded");
    return { name, ...(raw.description === undefined ? {} : { description: raw.description as string }) };
  });
}
export function setupConfigFromPolicyDraft(value: PolicyDraft): AllowlySetupConfig {
  const draft = object(value, "AI policy draft");
  if (Object.keys(draft).some(key => !["policy_id", "description", "definition", "action_definitions"].includes(key))) throw new Error("AI draft has unknown or legacy fields");
  const definition = validatePolicyDefinition(draft.definition);
  const actions = parseActions(draft.action_definitions);
  const names = new Set(actions.map(action => action.name));
  if (names.size !== actions.length || names.size !== definition.actions.length || definition.actions.some(item => !names.has(item.policy.action))) throw new Error("AI action descriptions must exactly match the complete definition");
  return { actions, policies: [parsePolicyConfig({ ...definition, policy_id: draft.policy_id, description: draft.description })] };
}
export function isSetupTemplateName(value: string): value is SetupTemplateName { return Object.prototype.hasOwnProperty.call(USE_CASE_SEEDS, value); }
export async function writeSampleSetupConfig(path = "allowly.setup.json", seed: AllowlySetupConfig = getSetupTemplate("email-agent")): Promise<void> {
  await writeFile(path, JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
}
function parseSetupConfig(value: unknown): AllowlySetupConfig {
  const raw = object(value, "setup config");
  if (Object.keys(raw).some(key => !["actions", "policies"].includes(key))) throw new Error("setup config has unknown fields");
  if (!Array.isArray(raw.policies)) throw new Error("setup config must include a policies array");
  return { actions: parseActions(raw.actions), policies: raw.policies.map(parsePolicyConfig) };
}
export async function loadSetupConfig(path: string): Promise<AllowlySetupConfig> {
  return parseSetupConfig(JSON.parse(await readFile(path, "utf8")));
}
export async function loadPolicyConfig(path: string): Promise<PolicyConfig> {
  return parsePolicyConfig(JSON.parse(await readFile(path, "utf8")));
}
export async function loadPolicyConfigs(path: string): Promise<PolicyConfig[]> {
  const raw = object(JSON.parse(await readFile(path, "utf8")), "policy file");
  if (raw.profile === "allowly.policy.v1") return [parsePolicyConfig(raw)];
  return parseSetupConfig(raw).policies;
}
