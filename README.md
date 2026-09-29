# Allowly CLI

Command-line setup tool for Allowly workspaces.

Use it after a human creates an account and verifies email. Billing is not required for setup. Free, Enterprise, and existing complimentary accounts need no payment method. Other Starter and Plus accounts require one after their first valid runtime check. `allowly login` opens the dashboard, asks the signed-in owner to approve CLI access, then stores a local CLI credential in `~/.allowly/config.json` with owner-only permissions.

After approval, the saved CLI credential can ask the app's AI drafting service for a local setup file:

```bash
allowly init --ai "Allow listing calendar events and require confirmation before deleting events."
```

This only writes `allowly.setup.json`. Review it first; the existing `actions apply` and `policies apply` commands create workspace resources.

Install the public npm package:

```bash
npm install -g @allowly-ai/cli
```

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

Use-case seeds are optional. If you already know your actions, create them first, then group them into policies per agent.

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

## Set up witnessed execution

After `allowly login`, install the Rust helper and pin this workspace's public
witness key:

```bash
allowly setup witness --archive /path/to/allowly-witness-poc-0.1.0-<target>.tar.gz --sha256 <archive-sha256>
```

For a locally built helper, use `allowly setup witness --helper /absolute/path/to/allowly-witness-poc`.
For the local development bridge, add `--witness-ca-cert /absolute/path/to/ca.pem`.
The CLI copies that local CA certificate into the workspace's witness setup and
pins its SHA-256 fingerprint. Both SDKs check the pinned certificate before
starting the helper. This option affects only the witness socket; provider
HTTPS continues to use normal public certificate authorities. Production
witness URLs with publicly trusted certificates do not need this option.
The CLI fetches only the public key, computes its SHA-256 fingerprint locally,
and opens the authenticated workspace page. Compare the two full fingerprints
and enter the one shown in the browser. A mismatch stops setup. The saved
configuration contains the workspace ID, public key path, helper path, and
fingerprint; it contains no setup credential or private key. The key and
configuration are stored under `ALLOWLY_CONFIG_DIR` or `~/.allowly/witness/<workspace-id>/`.

The release archives are being prepared. Until a published release manifest is
pinned in the CLI, supply a local archive and its expected SHA-256 digest, or a
helper built from the Rust project. The CLI checks the archive digest and accepts
only the supported macOS and glibc Linux helper targets.

For an existing Auth0-bound authorization, keep the short-lived machine access token in
`ALLOWLY_AGENT_TOKEN`, or select another environment variable with
`--agent-token-var`. The CLI sends it only in `X-Allowly-Agent-Token`. Add an
optional customer-reported event time with `--client-timestamp`; it must include
a timezone and does not replace Allowly's receipt time.

The CLI keeps `/v1/check` as a decision-only command. It does not currently
provide execution or receipt-acknowledgment commands. Use an Allowly SDK for
customer-side execution.

The command prints the runtime response unchanged. Signed receipts carry a
`schema_version`; `alg` and `key_id` are signed top-level fields, and `signature` is the
unpadded base64url string. Use an Allowly SDK verifier for offline verification.
