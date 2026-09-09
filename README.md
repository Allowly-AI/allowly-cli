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

The command prints the runtime response unchanged. Signed receipts carry a
`schema_version`; `alg` and `key_id` are signed top-level fields, and `signature` is the
unpadded base64url string. Use an Allowly SDK verifier for offline verification.
