import { Allowly, AllowlyAPIError, hashSealValue, type PolicyResponse } from "@allowly/sdk";
import type { CliConfig } from "./config.js";
import { AllowlyCliError } from "./http.js";
import { policyDefinition, type PolicyConfig } from "./setupConfig.js";

function client(config: CliConfig): Allowly {
  return new Allowly({ apiKey: config.accessToken, baseUrl: config.apiUrl,
    requestTimeoutMs: 30_000,
    // The saved CLI config already selects the operator's local API transport.
    dangerouslyAllowInsecureBaseUrl: config.apiUrl.startsWith("http://"),
  });
}
async function withClient<T>(config: CliConfig, operation: (sdk: Allowly) => Promise<T>): Promise<T> {
  try { return await operation(client(config)); }
  catch (error) {
    if (error instanceof AllowlyAPIError) {
      const redact = (value: string) => value.split(config.accessToken).join("[REDACTED]");
      throw new AllowlyCliError(redact(error.message), error.status, redact(error.code));
    }
    throw error;
  }
}
function request(policy: PolicyConfig) {
  return { policyId: policy.policy_id, definition: policyDefinition(policy),
    ...(policy.description === undefined ? {} : { description: policy.description }),
    ...(policy.previous_policy_ref === undefined ? {} : { previousPolicyRef: policy.previous_policy_ref }) };
}
export async function applyPolicies(config: CliConfig, policies: PolicyConfig[]): Promise<void> {
  await withClient(config, async sdk => {
    const existing = new Map<string, PolicyResponse>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await sdk.policies.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      page.items.forEach(item => existing.set(item.policyRef.policy_id, item));
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("policy list repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const policy of policies) {
      const current = existing.get(policy.policy_id);
      if (current && policy.previous_policy_ref === undefined) {
        if (current.policyRef.definition_sha256 !== hashSealValue(policyDefinition(policy))) {
          throw new Error(`policy ${policy.policy_id} already exists with a different definition; name its exact previous_policy_ref to create a successor`);
        }
        console.log(`skip policy ${policy.policy_id} (edition ${current.policyRef.policy_version})`);
        continue;
      }
      const created = await sdk.policies.create(request(policy));
      existing.set(policy.policy_id, created);
      console.log(`created policy ${policy.policy_id} (edition ${created.policyRef.policy_version})`);
    }
  });
}
export async function previewPolicy(config: CliConfig, policy: PolicyConfig, action: string, context: Record<string, unknown>) {
  return withClient(config, sdk => sdk.policies.preview({ definition: policyDefinition(policy), action, context }));
}
export async function publishPolicy(config: CliConfig, policy: PolicyConfig, idempotencyKey: string) {
  return withClient(config, sdk => sdk.policies.publish({ ...request(policy), idempotencyKey }));
}
