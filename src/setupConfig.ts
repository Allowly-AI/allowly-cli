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

export type SetupTemplateName =
  | "email-agent"
  | "browser-agent"
  | "client-intelligence"
  | "hiring-disposition"
  | "mcp-tool-gating"
  | "no-code-automation";

export const SETUP_TEMPLATE_NAMES: SetupTemplateName[] = [
  "email-agent",
  "browser-agent",
  "client-intelligence",
  "hiring-disposition",
  "mcp-tool-gating",
  "no-code-automation",
];

export const SETUP_TEMPLATE_DESCRIPTIONS: Record<SetupTemplateName, string> = {
  "email-agent": "Email assistant with read/send scopes and confirmation before sending.",
  "browser-agent": "Browser automation with confirmation before clicks and form submits.",
  "client-intelligence": "Sales and marketing research agent for web search, CRM/contact reads, lead enrichment, and confirmed outreach.",
  "hiring-disposition": "Interview-feedback synthesizer with conditional human review on borderline drafts and every reject recommendation, plus compliance escalation on protected-class proxies.",
  "mcp-tool-gating": "MCP tool gating for Claude/MCP agents: read tools allow autonomously, write tools confirm, destructive tools escalate.",
  "no-code-automation": "Drop-the-Check-node guardrails for n8n / Zapier / Make: high-volume sends confirm, EU prospects honor consent, suspected duplicates escalate.",
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
  "mcp-tool-gating": {
    scopes: [
      {
        name: "github.issue.read",
        description: "Read issue metadata and comments.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "github.pr.create",
        description: "Open a pull request against a repository.",
        requires_confirm: true,
        constraints_schema: {
          context_fields: {
            target_branch: "string",
            target_visibility: "string",
          },
        },
      },
      {
        name: "github.repo.delete",
        description: "Delete a GitHub repository.",
        requires_escalation: true,
        escalation_to: "security@example.com",
        constraints_schema: {},
      },
      {
        name: "slack.message.read",
        description: "Read Slack channel and DM messages.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "slack.message.send",
        description: "Post a message to a Slack channel or DM.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            channel_id: "string",
            channel_visibility: "string",
            channel_member_count: "integer",
            mentions_external: "boolean",
          },
        },
      },
      {
        name: "slack.channel.archive",
        description: "Archive a Slack channel.",
        requires_escalation: true,
        escalation_to: "security@example.com",
        constraints_schema: {},
      },
      {
        name: "drive.file.read",
        description: "Read a Drive file.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "drive.file.write",
        description: "Create or edit a Drive file.",
        requires_confirm: true,
        constraints_schema: {},
      },
      {
        name: "drive.file.delete",
        description: "Delete a Drive file.",
        requires_escalation: true,
        escalation_to: "security@example.com",
        constraints_schema: {},
      },
      {
        name: "secret.rotate",
        description: "Rotate a managed secret.",
        requires_escalation: true,
        escalation_to: "security@example.com",
        constraints_schema: {},
      },
    ],
    agent_scope_bundles: [
      {
        id: "mcp-tool-gating-basic",
        agent_id: "mcp-agent",
        description: "Per-tool MCP gating: read autonomously, confirm writes, escalate destructive operations. Pair with AllowlyMCPMiddleware.",
        scopes: [
          { name: "github.issue.read" },
          {
            name: "github.pr.create",
            constraints: {
              confirm_when: [
                { field: "target_branch", eq: "main" },
                { field: "target_visibility", eq: "public" },
              ],
            },
          },
          { name: "github.repo.delete" },
          { name: "slack.message.read" },
          {
            name: "slack.message.send",
            constraints: {
              confirm_when: [
                { field: "channel_visibility", eq: "public" },
                { field: "channel_member_count", gte: 50 },
                { field: "mentions_external", eq: true },
              ],
              escalate_when: [
                { field: "channel_id", in: ["security-incidents", "all-hands"] },
              ],
            },
          },
          { name: "slack.channel.archive" },
          { name: "drive.file.read" },
          { name: "drive.file.write" },
          { name: "drive.file.delete" },
          { name: "secret.rotate" },
        ],
        requires_confirm_for: ["drive.file.write"],
        requires_escalation_for: [
          "github.repo.delete",
          "slack.channel.archive",
          "drive.file.delete",
          "secret.rotate",
        ],
        escalation_targets: {
          "github.repo.delete": "security@example.com",
          "slack.channel.archive": "security@example.com",
          "drive.file.delete": "security@example.com",
          "secret.rotate": "security@example.com",
          "slack.message.send": "security@example.com",
        },
        default_expiry_days: 30,
      },
    ],
  },
  "no-code-automation": {
    scopes: [
      {
        name: "email.draft",
        description: "Draft outbound email for a no-code workflow to send later.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "email.send",
        description: "Send outbound email from a no-code workflow.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            recipient_count: "integer",
            prospect_region: "string",
            campaign_type: "string",
            mentions_pricing: "boolean",
            domain_suppression_match: "boolean",
          },
        },
      },
      {
        name: "crm.contact.update",
        description: "Update fields on a CRM contact record.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            looks_like_duplicate: "boolean",
            overwrites_human_edit: "boolean",
          },
        },
      },
      {
        name: "crm.opportunity.create",
        description: "Create a CRM opportunity record.",
        requires_confirm: false,
        constraints_schema: {},
      },
      {
        name: "calendar.event.create",
        description: "Create a calendar event and invite attendees.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            attendee_count: "integer",
            is_external: "boolean",
          },
        },
      },
      {
        name: "slack.message.post",
        description: "Post a Slack message from a no-code workflow.",
        requires_confirm: false,
        constraints_schema: {
          context_fields: {
            channel_visibility: "string",
            channel_member_count: "integer",
          },
        },
      },
    ],
    agent_scope_bundles: [
      {
        id: "no-code-automation-basic",
        agent_id: "no-code-workflow",
        description: "Guardrails for n8n / Zapier / Make: high-volume sends confirm, EU prospects honor consent, suspected duplicates escalate. Drop the Allowly Check node before any side-effect node and branch on the returned decision.",
        scopes: [
          { name: "email.draft" },
          {
            name: "email.send",
            constraints: {
              max_per_day: 200,
              confirm_when: [
                { field: "recipient_count", gte: 100 },
                { field: "prospect_region", in: ["EU", "UK"] },
                { field: "campaign_type", eq: "cold_outreach" },
                { field: "mentions_pricing", eq: true },
              ],
              escalate_when: [
                { field: "domain_suppression_match", eq: true },
                { field: "recipient_count", gte: 1000 },
              ],
            },
          },
          {
            name: "crm.contact.update",
            constraints: {
              confirm_when: [
                { field: "looks_like_duplicate", eq: true },
              ],
              escalate_when: [
                { field: "overwrites_human_edit", eq: true },
              ],
            },
          },
          { name: "crm.opportunity.create" },
          {
            name: "calendar.event.create",
            constraints: {
              confirm_when: [
                { field: "attendee_count", gte: 20 },
                { field: "is_external", eq: true },
              ],
            },
          },
          {
            name: "slack.message.post",
            constraints: {
              confirm_when: [
                { field: "channel_visibility", eq: "public" },
                { field: "channel_member_count", gte: 100 },
              ],
            },
          },
        ],
        escalation_targets: {
          "email.send": "ops@example.com",
          "crm.contact.update": "ops@example.com",
        },
        default_expiry_days: 90,
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
