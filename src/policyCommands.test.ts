import { hashSealValue } from "@allowly/sdk";
import { afterEach, expect, test, vi } from "vitest";
import { AllowlyCliError } from "./http.js";
import { applyPolicies, previewPolicy, publishPolicy } from "./policyCommands.js";
import { getSetupTemplate, policyDefinition } from "./setupConfig.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const config = { apiUrl: "http://127.0.0.1:8443", accessToken: "setup-secret" };
function policyResponse(version = 1) {
  const policy = getSetupTemplate("email-agent").policies[0];
  const definition = policyDefinition(policy);
  return { policy_ref: { policy_id: policy.policy_id, policy_version: version, definition_sha256: hashSealValue(definition) },
    definition, description: policy.description, created_by: "member:owner", created_at: "2026-10-10T00:00:00Z", deleted_at: null };
}
test("apply uses the SDK's strict complete flat create request and saved local credential", async () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [], has_more: false, next_cursor: null })))
    .mockResolvedValueOnce(new Response(JSON.stringify(policyResponse()), { status: 201 }));
  vi.stubGlobal("fetch", fetch); vi.spyOn(console, "log").mockImplementation(() => {});
  await applyPolicies(config, [policy]);
  expect(fetch.mock.calls[0][0]).toBe(`${config.apiUrl}/v1/policies?limit=100`);
  expect(fetch.mock.calls[1][0]).toBe(`${config.apiUrl}/v1/policies`);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(policy);
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer setup-secret");
  expect(fetch.mock.calls[1][1].redirect).toBe("manual");
  expect(fetch.mock.calls[1][1].headers["X-Allowly-Agent-Token"]).toBeUndefined();
});
test("apply only skips the same retained definition, not a different policy with the same ID", async () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [policyResponse()], has_more: false, next_cursor: null })));
  vi.stubGlobal("fetch", fetch); vi.spyOn(console, "log").mockImplementation(() => {});
  await applyPolicies(config, [policy]); expect(fetch).toHaveBeenCalledTimes(1);
  policy.actions[0].policy.decision = "deny";
  fetch.mockResolvedValue(new Response(JSON.stringify({ items: [policyResponse()], has_more: false, next_cursor: null })));
  await expect(applyPolicies(config, [policy])).rejects.toThrow("exact previous_policy_ref");
});
test("publish sends its exact previous edition and stable key without a nested definition wrapper", async () => {
  const policy = getSetupTemplate("email-agent").policies[0];
  policy.previous_policy_ref = policyResponse().policy_ref;
  const published = { policy_ref: policyResponse(2).policy_ref, agent_id: policy.agent_id, created_by: "member:owner",
    created_at: "2026-10-10T00:00:00Z", authorization_migrations: [], archived_policy_ids: [], revoked_confirmation_count: 0 };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(published), { status: 201 })); vi.stubGlobal("fetch", fetch);
  expect((await publishPolicy(config, policy, "publish-2")).policyRef).toEqual(published.policy_ref);
  expect(fetch.mock.calls[0][0]).toBe(`${config.apiUrl}/v1/setup/policies/publish`);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(policy);
  expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("publish-2");
});
test("preview uses native provisional evidence and checks only the sent input commitment", async () => {
  const policy = getSetupTemplate("email-agent").policies[0], context = { risk: 2 }, action = "email.read";
  const evaluation = { input_sha256: hashSealValue({ policy: policy.actions[0].policy, action, context }),
    result: { profile: "allowly.basic.v1", status: "ok", decision: "allow", target: null, matched_rule_id: null, evaluated_fields: {} } };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ provisional: true, definition_sha256: hashSealValue(policyDefinition(policy)), action, policy_eval: evaluation })));
  vi.stubGlobal("fetch", fetch);
  const result = await previewPolicy(config, policy, action, context);
  expect(result.provisional).toBe(true); expect(result.policyEval).toEqual(evaluation);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ definition: policyDefinition(policy), action, context });
});
test("SDK errors preserve CLI status/code and redact the setup credential", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "setup_key_required", message: "setup-secret cannot use this route" } }), { status: 403 })));
  await expect(previewPolicy(config, getSetupTemplate("email-agent").policies[0], "email.read", {}))
    .rejects.toMatchObject({ constructor: AllowlyCliError, status: 403, code: "setup_key_required", message: "[REDACTED] cannot use this route" });
});
