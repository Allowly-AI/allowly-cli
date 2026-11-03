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
  responseFormat: "json" | "text" = "json",
): Promise<T> {
  if (responseFormat === "text" && !["http:", "https:"].includes(new URL(config.apiUrl).protocol)) {
    throw new AllowlyCliError("API URL must use HTTP or HTTPS");
  }
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl.replace(/\/$/, "")}${path}`, {
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
  } catch (error) {
    if (responseFormat === "text") throw new AllowlyCliError("Allowly request failed");
    throw error;
  }

  if (responseFormat === "text" && response.redirected) {
    throw new AllowlyCliError("Redirected instructions responses are not allowed");
  }
  if (responseFormat === "text" && response.ok) {
    if (response.status !== 200 || response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "text/plain") {
      throw new AllowlyCliError("Instructions response must be HTTP 200 text/plain");
    }
    let instructions: string;
    try { instructions = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer()); }
    catch { throw new AllowlyCliError("Instructions response must be UTF-8"); }
    if (!instructions.trim() || instructions.trimStart().startsWith("<") || instructions.includes(config.accessToken)) {
      throw new AllowlyCliError("Instructions response must contain nonempty plain-text guidance");
    }
    try { JSON.parse(instructions); }
    catch { return instructions as T; }
    throw new AllowlyCliError("Instructions response must not be JSON");
  }

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
