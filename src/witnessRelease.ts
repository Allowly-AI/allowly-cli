/** Updated only when the audited release assets are prepared for publication. */
export const WITNESS_RELEASE: {
  version: string;
  baseUrl: string;
  manifestSha256: string | null;
} = {
  version: "0.1.0",
  baseUrl: "https://github.com/Allowly-AI/allowly-mcp/releases/download/witness-v0.1.0/",
  manifestSha256: null,
};
