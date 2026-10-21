# Allowly CLI

Set up Allowly policy checks before agent tool calls and keep signed decision receipts.

An agent can start a signup-free Free trial with 1,000 lifetime decisions:

```bash
allowly trial create --name "My agent" --json
allowly trial status --json
```

Follow the [agent onboarding recipe](https://allowly.ai/docs/agents/) to author
your own policy, enroll a local key, create a new authorization, check a real
tool, and verify a fresh signed receipt with the existing SDK. The trial service
must be enabled, and your CLI release must include `allowly trial create`.

The CLI saves recovery proof before its first request. Rerun the same command
after an interrupted response to recover the same workspace.
`allowly trial recover --json` explicitly rotates setup/claim secrets only within the first 15 minutes
and before setup starts. It never restores decisions.

Output contains safe metadata and file paths. `config.json`, `trial.json`, and
`trial-claim-url.txt` under `ALLOWLY_CONFIG_DIR` (default `~/.allowly`) use
owner-only permissions. The config saves trusted `workspaceId` and `apiUrl` for
setup and receipt verification. Hand the secret claim link to the intended person
through a private channel. A verified person reviews and claims the same account;
claim preserves usage and replaces old access. At 429 `quota_exceeded`, stop the
tool and show the protected claim-file path. Unclaimed trials expire after seven days.

Use a separate private `ALLOWLY_CONFIG_DIR` when another workspace is already
configured. Keep secret files and agent keys out of source control, logs, and chat.

For an existing human-owned workspace, use it after a human creates an account and verifies email. Billing is not required for setup. Free, Enterprise, and existing complimentary accounts need no payment method. Other Starter and Plus accounts require one after their first valid runtime check. `allowly login` opens the dashboard, asks the signed-in owner to approve CLI access, then stores a local CLI credential in `~/.allowly/config.json` with owner-only permissions.

After approval, the saved CLI credential can ask the app's AI drafting service for a local setup file:

```bash
allowly init --ai "Allow listing calendar events and require confirmation before deleting events."
```

This only writes `allowly.setup.json`. Review it first; the existing `actions apply` and `policies apply` commands create workspace resources.

Install the public npm package:

```bash
npm install -g @allowly-ai/cli
```

Observe reporting is available in CLI `0.4.0`, which installs SDK `0.9.0`
from the npm registry.

Then:

```bash
allowly login
allowly init --ai "Allow listing calendar events and confirm before deleting events."
allowly actions apply allowly.setup.json
allowly policies apply allowly.setup.json
allowly keys create --write-env .env.local --var ALLOWLY_API_KEY
allowly agent enroll my-agent
allowly setup guide
allowly check --authorization-id auth_... --action web.search --runtime-env .env.local --agent-credential /path/to/agent.json
```

Use `allowly init --use-case email-agent` instead when you want a built-in seed rather than AI drafting.

`allowly login` talks to the dashboard app for browser approval and stores the public API URL returned by Allowly for setup calls. Use `--app-url` for local app development and `--api-url` only when you need to override the API URL written to the local CLI config.

Login saves the browser dashboard origin returned by Allowly separately from
the control-plane API address. For example, a local login can use
`http://127.0.0.1:8480` for API requests while browser pages open at
`https://localhost:8843`.
Advanced `login --setup-token` also keeps the chosen `--app-url` and `--api-url`
in the local config; it does not run the browser approval flow.

## Report observed activity

Use a runtime API key without a CLI login:

```bash
allowly observe submit event.json --runtime-env .env.local
allowly observe get operation:1 --runtime-env .env.local
```

`event.json` contains exactly `event_id`, `agent_id`, `action`, `policy_ref`,
`occurred_at`, `reported_execution`, and `sources`. `policy_ref` names the exact
approved policy ID, version, and definition digest. Source values are captured
strings. Use `sent`, `accepted`, `failed`, or `unknown` for the application's
reported execution outcome.

Submission records activity for an asynchronous policy review. It does not
execute or block the action. Poll the event to see processing and assessment
status; an unfinished review is not a finding of compliance.

## Optional use-case seeds

```bash
allowly init --list-use-cases
allowly init --use-case email-agent
allowly init --use-case browser-agent
allowly init --use-case client-intelligence
allowly init --use-case hr-ops
allowly init --use-case mcp-guardrails
allowly init --use-case no-code-automation
allowly init --manual
```

Use-case seeds are optional. They contain complete `allowly.policy.v1` definitions with action-level `decision`/`target` and ordered `allowly.basic.v1` rules. Conditions within a rule use OR; rules may strengthen, but never weaken, the action decision. Catalog entries contain only names and descriptions. Old fallback fields, inline constraints, and `requires_*` decision maps are rejected.

Apply a setup file, or a standalone flat policy JSON file:

```bash
allowly actions apply allowly.setup.json
allowly policies apply allowly.setup.json
allowly policies preview policy.json --action email.send --context '{"recipient_scope":"external"}'
allowly policies publish policy.json --idempotency-key publish-email-edition-2
```

`policy.json` contains the full definition fields (`profile`, `agent_id`, `actions`, `default_expiry_days`) alongside its logical `policy_id` and optional `description`. Do not wrap the API body in `definition`. To create a successor, include the exact `previous_policy_ref` returned for the prior edition: its `policy_id`, positive integer `policy_version`, and `definition_sha256`.

Optional action-level `evidence` declares extraction requirements for every
`policy.fields` entry. The shared SDK validates and retains AI instructions,
`email_domain` extraction and direct-boolean `all_of` requirements through
drafts, files, apply, preview and publish. Evidence changes alter the complete
definition hash. Observation source mappings are configured separately;
preview evaluates the context you supply.

Apply skips an existing policy only when its retained definition hash is identical. A changed definition requires an explicit previous reference. Publish checks owner, member, and executable-operation permissions on the server; it may replace that owner's grants. Preview reports provisional OPA output only. It does not authorize execution or check live grant limits. The MCP sensitive-tool seed stays denied until you configure a real `member:<ID>` reviewer.

CLI credentials can configure actions, policies, setup status, and runtime-key creation. They cannot call `/v1/check`, access billing, manage users, or change passwords.

Runtime API keys are shown once. Write them to local env files or a secret manager; do not paste them into logs, tickets, or chat transcripts.

## Enroll an agent

Create the agent in the dashboard, then run `allowly agent enroll <exact-agent-id>`
with your Allowly CLI login. The command creates an Ed25519 signing key on this
machine, registers only its public key with Allowly, and saves the private
credential in an owner-only file under `~/.allowly/agents/` (or
`ALLOWLY_CONFIG_DIR/agents/`). Use `--out /path/to/agent.json` to choose the
location. The command prints that path, never the private key.

You can enroll a dashboard agent before creating its policy. CLI-only setups
can still enroll after creating a live policy. Enrollment does not grant
permission: define the policy and create a new authorization before runtime use.

The private credential must be available to the trusted process that runs the
agent. Move it using your usual secret-management process if enrollment and
runtime happen on different machines. Do not put it in source control, logs, or
workflow output. If registration was interrupted, rerun the same command with
`--resume` and the same `--out` path; it reuses the pending key.
During a staged rollout, enrollment may return
`native_agent_enrollment_disabled` until the runtime is ready. The CLI keeps
the pending private file; rerun with `--resume` after enrollment is enabled.

Create a **new authorization** after enrollment so the agent identity is
recorded on that grant. The existing workspace runtime API key is still required
for checks. For a quick check, add `--agent-credential /path/to/agent.json`;
the CLI signs a short-lived agent token and sends it in
`X-Allowly-Agent-Token`. In deployed agent code, use
`NativeAgentCredential.fromFile(...).token` in the TypeScript SDK or
`NativeAgentCredential.from_file(...).token` in the Python SDK as the token
supplier. The private key stays on the agent's trusted machine.

Use `--write-env` for local env-file output. `--env-file` is intentionally not documented because recent Node versions reserve that flag for Node itself.

`allowly check` is a runtime helper. It requires a runtime API key from `--api-key`, `ALLOWLY_API_KEY`, or `--runtime-env`; it does not use the CLI setup credential. Receipt signing still happens server-side in the Allowly API.

## Remove an agent identity

`allowly agent remove <exact-agent-id>` lists and revokes the agent's active
credentials after confirmation. Use `--key-id <key-id>` to revoke only one
credential, or `--yes` for non-interactive use. Requests signed with revoked
keys stop working. Policies, authorization records, and local private files
are kept. If no active keys remain, enroll again with a new `--out` path and
create new authorizations. `allowly logout` only revokes the CLI login.

The dashboard also offers **Remove identity** and individual **Revoke key**
controls under the agent's **Integrate** page.

For an existing Auth0-bound authorization, keep the short-lived machine access token in
`ALLOWLY_AGENT_TOKEN`, or select another environment variable with
`--agent-token-var`. The CLI sends it only in `X-Allowly-Agent-Token`. Add an
optional customer-reported event time with `--client-timestamp`; it must include
a timezone and does not replace Allowly's receipt time.

The CLI keeps `/v1/check` as a decision-only command. It does not currently
provide execution or receipt-acknowledgment commands. Use an Allowly SDK for
customer-side execution.

The command prints the runtime response unchanged. Signed receipts carry a
flattened JWS object with `protected`, `payload`, and `signature` strings. The
protected header binds the algorithm and key ID; decoded evidence carries
`schema_version`. Runtime receipts use wire 5 and the published verifier
5.0.0. Use the matching SDK verifier for signature verification against your
configured workspace. Policy replay is a separate native OPA check with retained
policy, input, and engine artifacts; a signature alone is not replay.
