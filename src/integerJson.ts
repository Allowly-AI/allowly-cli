/** Policy and check inputs use the runtime's integer-only JSON number profile. */
export function parseIntegerJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // Match complete strings first, so numbers inside quoted text stay data.
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (!token.startsWith('"') && (/[.eE]/.test(token) || !Number.isSafeInteger(Number(token))))
      throw new Error("JSON numbers must be safe whole integers");
  }
  return value;
}
