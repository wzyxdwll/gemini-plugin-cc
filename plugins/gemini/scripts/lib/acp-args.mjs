import process from "node:process";

export const ACP_ALLOWED_MCP_SERVERS_ENV = "GEMINI_COMPANION_ACP_ALLOWED_MCP_SERVERS";

const NO_MCP_SENTINEL = "__gemini_plugin_cc_no_mcp__";

export function buildGeminiAcpArgs(env = process.env) {
  const rawAllowed = env?.[ACP_ALLOWED_MCP_SERVERS_ENV];
  const allowed = typeof rawAllowed === "string" && rawAllowed.trim()
    ? rawAllowed.trim()
    : NO_MCP_SENTINEL;

  return ["--acp", "--allowed-mcp-server-names", allowed];
}
