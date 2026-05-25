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
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = text ? JSON.parse(text) as ApiErrorBody : {};
  if (!response.ok) {
    const code = parsed.error?.code ?? "error";
    const message = parsed.error?.message ?? `Allowly API returned ${response.status}`;
    // Never include Authorization headers or token-looking input in CLI errors.
    throw new AllowlyCliError(message, response.status, code);
  }
  return parsed as T;
}
