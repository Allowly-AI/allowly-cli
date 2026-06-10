import { readFile, writeFile } from "node:fs/promises";

export interface ScopeConfig {
  name: string;
  description?: string;
  requires_confirm?: boolean;
  requires_escalation?: boolean;
  escalation_to?: string;
  constraints_schema?: Record<string, unknown>;
}

export interface BundleConfig {
  id: string;
  agent_id: string;
  description?: string;
  scopes: Array<{ name: string; constraints?: Record<string, unknown> }>;
  requires_confirm_for?: string[];
  requires_escalation_for?: string[];
  escalation_targets?: Record<string, string>;
  default_expiry_days?: number;
}

export interface AllowlySetupConfig {
  scopes: ScopeConfig[];
  agent_scope_bundles: BundleConfig[];
}

export type SetupTemplateName = "email-agent" | "browser-agent" | "client-intelligence" | "hiring-disposition";

export const SETUP_TEMPLATE_NAMES: SetupTemplateName[] = [
  "email-agent",
  "browser-agent",
  "client-intelligence",
  "hiring-disposition",
];

export const SETUP_TEMPLATE_DESCRIPTIONS: Record<SetupTemplateName, string> = {
  "email-agent": "Email assistant with read/send scopes and confirmation before sending.",
  "browser-agent": "Browser automation with confirmation before clicks and form submits.",
  "client-intelligence": "Sales and marketing research agent for web search, CRM/contact reads, lead enrichment, and confirmed outreach.",
  "hiring-disposition": "Interview-feedback synthesizer with conditional human review on borderline drafts and every reject recommendation, plus compliance escalation on protected-class proxies.",
};

export const SETUP_TEMPLATES: Record<SetupTemplateName, AllowlySetupConfig> = {
  "email-agent": {
    scopes: [
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
    agent_scope_bundles: [
      {
        id: "email-agent-basic",
        agent_id: "email-agent",
        description: "Basic email assistant permissions.",
        scopes: [
          { name: "email.read" },
          { name: "email.send", constraints: { max_per_day: 5 } },
        ],
        requires_confirm_for: ["email.send"],
        default_expiry_days: 90,
      },
    ],
  },
  "browser-agent": {
    scopes: [
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
        requires_confirm: true,
        constraints_schema: {},
      },
    ],
    agent_scope_bundles: [
      {
        id: "browser-agent-basic",
        agent_id: "browser-agent",
        description: "Browser automation with confirmation before side effects.",
        scopes: [
          { name: "browser.read" },
          { name: "browser.click", constraints: { allowed_domains: [] } },
          { name: "browser.form.submit" },
        ],
        requires_confirm_for: ["browser.click", "browser.form.submit"],
        default_expiry_days: 30,
      },
    ],
  },
  "hiring-disposition": {
    scopes: [
      {
        name: "hiring.synthesize_feedback",
        description: "Draft an interview-feedback summary for the interviewer to review.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            confidence_score: "integer",
            transcript_completeness: "integer",
            rule_fired: "string",
            decision_recommended: "string",
          },
        },
      },
      {
        name: "hiring.recommend_disposition",
        description: "Emit a hire/reject/no-recommendation signal to the ATS.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            confidence_score: "integer",
            score: "integer",
            score_delta: "integer",
            panel_consensus: "boolean",
            candidate_ai_opt_out: "boolean",
            rule_fired: "string",
            decision_recommended: "string",
          },
        },
      },
    ],
    agent_scope_bundles: [
      {
        id: "hiring-disposition-basic",
        agent_id: "hiring-feedback-synthesizer",
        description: "Interview-feedback synthesizer with conditional review on borderline drafts and every reject recommendation. Demonstrates confirm_when, escalate_when, and policy_eval evidence.",
        scopes: [
          {
            name: "hiring.synthesize_feedback",
            constraints: {
              confirm_when: [
                { field: "confidence_score", lt: 70 },
                { field: "transcript_completeness", lt: 80 },
                { field: "rule_fired", in: ["halo_effect_detected", "narrative_inconsistency"] },
              ],
              escalate_when: [
                { field: "rule_fired", in: ["demographic_proxy"] },
              ],
            },
          },
          {
            name: "hiring.recommend_disposition",
            constraints: {
              confirm_when: [
                { field: "decision_recommended", eq: "reject" },
                { field: "confidence_score", lt: 85 },
                { field: "score_delta", gte: 5 },
                { field: "panel_consensus", eq: false },
                { field: "candidate_ai_opt_out", eq: true },
                { field: "rule_fired", in: ["employment_gap_factor", "availability_factor", "halo_effect_detected"] },
              ],
              escalate_when: [
                { field: "rule_fired", in: ["demographic_proxy"] },
                { field: "score", exists: false },
              ],
            },
          },
        ],
        escalation_targets: {
          "hiring.synthesize_feedback": "compliance@example.com",
          "hiring.recommend_disposition": "compliance@example.com",
        },
        default_expiry_days: 90,
      },
    ],
  },
  "client-intelligence": {
    scopes: [
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
    agent_scope_bundles: [
      {
        id: "client-intelligence-basic",
        agent_id: "client-intelligence",
        description: "Sales and marketing client-intelligence permissions with confirmation before enrichment and outreach.",
        scopes: [
          { name: "web.search" },
          { name: "web.page.read" },
          { name: "contact.profile.read" },
          { name: "crm.account.read" },
          { name: "lead.enrich", constraints: { allowed_fields: [] } },
          { name: "email.draft" },
          { name: "email.send", constraints: { max_per_day: 25 } },
        ],
        requires_confirm_for: ["lead.enrich", "email.send"],
        default_expiry_days: 90,
      },
    ],
  },
};

export const SAMPLE_SETUP_CONFIG: AllowlySetupConfig = SETUP_TEMPLATES["email-agent"];

export function getSetupTemplate(name: SetupTemplateName): AllowlySetupConfig {
  return SETUP_TEMPLATES[name];
}

export function isSetupTemplateName(value: string): value is SetupTemplateName {
  return SETUP_TEMPLATE_NAMES.includes(value as SetupTemplateName);
}

export async function writeSampleSetupConfig(
  path = "allowly.setup.json",
  seed: AllowlySetupConfig = SAMPLE_SETUP_CONFIG,
): Promise<void> {
  await writeFile(path, JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
}

export async function loadSetupConfig(path: string): Promise<AllowlySetupConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AllowlySetupConfig>;
  if (!Array.isArray(parsed.scopes)) throw new Error("allowly setup config must include a scopes array");
  if (!Array.isArray(parsed.agent_scope_bundles)) {
    throw new Error("allowly setup config must include an agent_scope_bundles array");
  }
  for (const scope of parsed.scopes) {
    if (!scope?.name) throw new Error("each scope must include name");
  }
  for (const bundle of parsed.agent_scope_bundles) {
    if (!bundle?.id) throw new Error("each agent scope bundle must include id");
    if (!bundle.agent_id) throw new Error(`agent scope bundle ${bundle.id} must include agent_id`);
    if (!Array.isArray(bundle.scopes) || bundle.scopes.length === 0) {
      throw new Error(`agent scope bundle ${bundle.id} must include at least one scope`);
    }
    for (const scope of bundle.scopes) {
      if (!scope?.name) throw new Error(`agent scope bundle ${bundle.id} has a scope without name`);
    }
  }
  return {
    scopes: parsed.scopes,
    agent_scope_bundles: parsed.agent_scope_bundles,
  };
}
