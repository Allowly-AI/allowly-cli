import type { CliConfig } from "./config.js";

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class AllowlyCliError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  config: CliConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!response.ok) {
    let parsed: ApiErrorBody = {};
    try {
      parsed = text ? JSON.parse(text) as ApiErrorBody : {};
    } catch {
      // Non-JSON proxy errors still get a useful status message.
    }
    const agentToken = extraHeaders["X-Allowly-Agent-Token"];
    const sensitiveValues = [config.accessToken, agentToken]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const redact = (value: string): string => {
      let rendered = value;
      for (const sensitiveValue of sensitiveValues) {
        rendered = rendered.split(sensitiveValue).join("[REDACTED]");
      }
      return rendered;
    };
    const code = redact(parsed.error?.code ?? "error");
    const rawMessage = parsed.error?.message ?? `Allowly API returned ${response.status}`;
    const message = redact(rawMessage);
    // Never include Authorization headers or token-looking input in CLI errors.
    throw new AllowlyCliError(message, response.status, code);
  }
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    // Parser errors may include a response snippet containing newly issued secrets.
    throw new AllowlyCliError("Allowly API returned invalid JSON", response.status);
  }
}

export async function listAll<T>(config: CliConfig, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiRequest<{ items: T[]; next_cursor?: string | null }>(
      config,
      "GET",
      `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
}
