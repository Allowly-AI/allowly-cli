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
allowly setup guide
allowly check --authorization-id auth_... --action web.search --runtime-env .env.local
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

Use `--write-env` for local env-file output. `--env-file` is intentionally not documented because recent Node versions reserve that flag for Node itself.

`allowly check` is a runtime helper. It requires a runtime API key from `--api-key`, `ALLOWLY_API_KEY`, or `--runtime-env`; it does not use the CLI setup credential. Receipt signing still happens server-side in the Allowly API.

## Set up witnessed execution

After `allowly login`, install the Rust helper and pin this workspace's public
witness key:

```bash
allowly setup witness --archive /path/to/allowly-witness-poc-0.1.0-<target>.tar.gz --sha256 <archive-sha256>
```

For a locally built helper, use `allowly setup witness --helper /absolute/path/to/allowly-witness-poc`.
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

For an Auth0-bound authorization, keep the short-lived machine access token in
`ALLOWLY_AGENT_TOKEN`, or select another environment variable with
`--agent-token-var`. The CLI sends it only in `X-Allowly-Agent-Token`. Add an
optional customer-reported event time with `--client-timestamp`; it must include
a timezone and does not replace Allowly's receipt time.

The CLI keeps `/v1/check` as a decision-only command. It does not currently
provide managed execution or receipt-acknowledgment commands. Use an Allowly
SDK, n8n, or Zapier for those flows.

The command prints the runtime response unchanged. Signed receipts carry a
`schema_version`; `alg` and `key_id` are signed top-level fields, and `signature` is the
unpadded base64url string. Use an Allowly SDK verifier for offline verification.
