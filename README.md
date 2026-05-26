# Allowly CLI

Command-line setup tool for Allowly workspaces.

Use it after a human creates an account, verifies email, and completes billing setup. `allowly login` opens the dashboard, asks the signed-in owner to approve CLI access, then stores a local CLI credential in `~/.allowly/config.json` with owner-only permissions.

```bash
allowly login --api-url https://api.allowly.ai
allowly init --use-case email-agent
allowly scopes apply allowly.setup.json
allowly bundles apply allowly.setup.json
allowly keys create --write-env .env.local --var ALLOWLY_API_KEY
allowly setup guide
allowly check --authorization-id auth_... --scope web.search --runtime-env .env.local
```

## Optional use-case seeds

```bash
allowly init --list-use-cases
allowly init --use-case email-agent
allowly init --use-case browser-agent
allowly init --use-case client-intelligence
allowly init --manual
allowly init --ai
```

Use-case seeds are optional. If you already know your permissions, create scopes first, then bundle them per agent.

CLI credentials can configure scopes, agent scope bundles, setup status, and runtime-key creation. They cannot call `/v1/check`, access billing, manage users, or change passwords.

Runtime API keys are shown once. Write them to local env files or a secret manager; do not paste them into logs, tickets, or chat transcripts.

Use `--write-env` for local env-file output. `--env-file` is intentionally not documented because recent Node versions reserve that flag for Node itself.

`allowly check` is a runtime helper. It requires a runtime API key from `--api-key`, `ALLOWLY_API_KEY`, or `--runtime-env`; it does not use the CLI setup credential. Receipt signing still happens server-side in the Allowly API.
