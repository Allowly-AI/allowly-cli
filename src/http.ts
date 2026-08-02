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
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    const code = parsed.error?.code ?? "error";
    const message = parsed.error?.message ?? `Allowly API returned ${response.status}`;
    // Never include Authorization headers or token-looking input in CLI errors.
    throw new AllowlyCliError(message, response.status, code);
  }
  return (text ? JSON.parse(text) : undefined) as T;
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
