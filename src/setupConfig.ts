import { readFile, writeFile } from "node:fs/promises";

export interface ActionConfig {
  name: string;
  description?: string;
  requires_confirm?: boolean;
  requires_escalation?: boolean;
  requires_deny?: boolean;
  escalation_to?: string;
  constraints_schema?: Record<string, unknown>;
}

export interface PolicyConfig {
  policy_id: string;
  agent_id: string;
  description?: string;
  actions: Array<{ name: string; constraints?: Record<string, unknown> }>;
  requires_confirm_for?: string[];
  requires_escalation_for?: string[];
  requires_deny_for?: string[];
  escalation_targets?: Record<string, string>;
  default_expiry_days?: number;
}

export interface AllowlySetupConfig {
  actions: ActionConfig[];
  policies: PolicyConfig[];
}

interface UseCaseSeed {
  label: string;
  description: string;
  actions: ActionConfig[];
}

const USE_CASE_SEEDS = {
  "email-agent": {
    label: "Email assistant",
    description: "Read and draft email, with confirmation before sending.",
    actions: [
      {
        name: "email.read",
        description: "Read user email metadata and message content.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "email.send",
        description: "Send email on behalf of the user.",
        requires_confirm: true,
        constraints_schema: {
          type: "object",
          properties: {
            max_per_day: { type: "integer", minimum: 1 },
          },
        },
      },
    ],
  },
  "browser-agent": {
    label: "Browser automation",
    description: "Read pages, click controls, and submit forms with confirmation before side effects.",
    actions: [
      {
        name: "browser.read",
        description: "Read page content, page metadata, and selected DOM text.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "browser.click",
        description: "Click links and buttons in the active browser session.",
        requires_confirm: true,
        constraints_schema: {
          type: "object",
          properties: {
            allowed_domains: { type: "array" },
          },
        },
      },
      {
        name: "browser.form.submit",
        description: "Submit forms that may change user data.",
        requires_confirm: false,
        requires_deny: true,
        constraints_schema: {},
      },
    ],
  },
  "client-intelligence": {
    label: "Client intelligence",
    description: "Sales and marketing research with contact/CRM reads, lead enrichment, and confirmed outreach.",
    actions: [
      {
        name: "web.search",
        description: "Search the public web for company, person, and market intelligence.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "web.page.read",
        description: "Read public webpages and search-result pages for prospect research.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "contact.profile.read",
        description: "Read private contact fields such as name, email, title, company, and notes.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "crm.account.read",
        description: "Read CRM account and opportunity context for client intelligence.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "lead.enrich",
        description: "Write enriched prospect or referral intelligence back to a lead record.",
        requires_confirm: true,
        constraints_schema: {
          type: "object",
          properties: {
            allowed_fields: { type: "array" },
          },
        },
      },
      {
        name: "email.draft",
        description: "Draft marketing, sales, or referral outreach using gathered intelligence.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "email.send",
        description: "Send marketing, sales, or referral outreach on behalf of the user.",
        requires_confirm: true,
        constraints_schema: {
          type: "object",
          properties: {
            max_per_day: { type: "integer", minimum: 1 },
          },
        },
      },
    ],
  },
  "hr-ops": {
    label: "HR and hiring",
    description: "Candidate review, recruiting ops, and sensitive employment actions with confirmation and escalation paths.",
    actions: [
      {
        name: "candidate.profile.read",
        description: "Read candidate profile, resume, and application data for recruiting review.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "candidate.score.update",
        description: "Write screening scores and recruiter notes back to the hiring system.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            score: "integer",
            score_delta: "integer",
            rule_fired: "list",
          },
        },
      },
      {
        name: "candidate.reject",
        description: "Reject or archive an applicant in the ATS.",
        requires_confirm: false,
        requires_escalation: true,
        escalation_to: "hr_approver",
        constraints_schema: {
          context_fields: {
            opt_out: "boolean",
            score: "integer",
            score_delta: "integer",
            rule_fired: "list",
          },
        },
      },
      {
        name: "candidate.outreach.send",
        description: "Send recruiting outreach or scheduling messages to candidates.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            opt_out: "boolean",
            template_name: "string",
          },
        },
      },
    ],
  },
  "mcp-guardrails": {
    label: "MCP guardrails",
    description: "Tool-call guardrails for MCP agents, with escalation available on Plus for high-risk tool actions.",
    actions: [
      {
        name: "mcp.tool.read",
        description: "Read tool metadata, arguments, and non-mutating tool results.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "mcp.tool.call",
        description: "Approve ordinary mutating MCP tool calls before the tool runs.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            tool_name: "string",
            estimated_cost_micros: "integer",
            resource: "string",
          },
        },
      },
      {
        name: "mcp.tool.call.sensitive",
        description: "Gate high-risk MCP tool calls such as deletes, credential changes, or external publishing.",
        requires_confirm: false,
        requires_escalation: true,
        escalation_to: "security_approver",
        constraints_schema: {
          context_fields: {
            tool_name: "string",
            resource: "string",
            estimated_cost_micros: "integer",
            action_type: "string",
          },
        },
      },
    ],
  },
  "no-code-automation": {
    label: "No-code automation",
    description: "n8n, Zapier, and Make workflows with explicit checks before record writes, sends, and irreversible steps.",
    actions: [
      {
        name: "workflow.record.read",
        description: "Read rows, records, and prior step outputs inside the workflow.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "workflow.record.update",
        description: "Create or update records in downstream systems from a workflow step.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            platform: "string",
            resource: "string",
            estimated_cost_micros: "integer",
          },
        },
      },
      {
        name: "workflow.message.send",
        description: "Send emails, Slack messages, or CRM outreach from a no-code workflow.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            platform: "string",
            recipient_type: "string",
            template_name: "string",
          },
        },
      },
      {
        name: "workflow.irreversible.execute",
        description: "Run destructive or externally visible workflow steps such as deletes, status flips, or production publishes.",
        requires_confirm: false,
        requires_deny: true,
        constraints_schema: {
          context_fields: {
            platform: "string",
            action_type: "string",
            resource: "string",
          },
        },
      },
    ],
  },
} satisfies Record<string, UseCaseSeed>;

export type SetupTemplateName = keyof typeof USE_CASE_SEEDS;

export const SETUP_TEMPLATE_NAMES = Object.keys(USE_CASE_SEEDS) as SetupTemplateName[];

export const SETUP_TEMPLATE_LABELS = Object.fromEntries(
  SETUP_TEMPLATE_NAMES.map((name) => [name, USE_CASE_SEEDS[name].label]),
) as Record<SetupTemplateName, string>;

export const SETUP_TEMPLATE_DESCRIPTIONS = Object.fromEntries(
  SETUP_TEMPLATE_NAMES.map((name) => [name, USE_CASE_SEEDS[name].description]),
) as Record<SetupTemplateName, string>;

function generatedPolicy(name: SetupTemplateName, seed: UseCaseSeed): PolicyConfig {
  const requires_confirm_for = seed.actions.filter((action) => action.requires_confirm).map((action) => action.name);
  const requires_escalation_for = seed.actions.filter((action) => action.requires_escalation).map((action) => action.name);
  const requires_deny_for = seed.actions.filter((action) => action.requires_deny).map((action) => action.name);
  const escalation_targets = Object.fromEntries(
    seed.actions
      .filter((action) => action.requires_escalation && action.escalation_to)
      .map((action) => [action.name, action.escalation_to as string]),
  );

  return {
    policy_id: `${name}-basic`,
    agent_id: name,
    description: seed.description,
    actions: seed.actions.map((action) => ({ name: action.name })),
    requires_confirm_for,
    requires_escalation_for,
    requires_deny_for,
    escalation_targets,
    default_expiry_days: 365,
  };
}

export function getSetupTemplate(name: SetupTemplateName): AllowlySetupConfig {
  const seed = USE_CASE_SEEDS[name];
  return {
    actions: seed.actions,
    policies: [generatedPolicy(name, seed)],
  };
}

export function isSetupTemplateName(value: string): value is SetupTemplateName {
  return value in USE_CASE_SEEDS;
}

export async function writeSampleSetupConfig(
  path = "allowly.setup.json",
  seed: AllowlySetupConfig = getSetupTemplate("email-agent"),
): Promise<void> {
  await writeFile(path, JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
}

export async function loadSetupConfig(path: string): Promise<AllowlySetupConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AllowlySetupConfig>;
  if (!Array.isArray(parsed.actions)) throw new Error("allowly setup config must include an actions array");
  if (!Array.isArray(parsed.policies)) {
    throw new Error("allowly setup config must include a policies array");
  }
  for (const action of parsed.actions) {
    if (!action?.name) throw new Error("each action must include name");
  }
  for (const policy of parsed.policies) {
    if (!policy?.policy_id) throw new Error("each policy must include policy_id");
    if (!policy.agent_id) throw new Error(`policy ${policy.policy_id} must include agent_id`);
    if (!Array.isArray(policy.actions) || policy.actions.length === 0) {
      throw new Error(`policy ${policy.policy_id} must include at least one action`);
    }
    for (const action of policy.actions) {
      if (!action?.name) throw new Error(`policy ${policy.policy_id} has an action without name`);
    }
  }
  return {
    actions: parsed.actions,
    policies: parsed.policies,
  };
}
