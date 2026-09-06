/** The closed MCP Tool plane Contexture owns for every application. */
export const GATEWAY_TOOL_NAMES = Object.freeze([
  'contexture_discover',
  'contexture_open',
  'contexture_invoke_read_only',
  'contexture_invoke',
] as const);

/** The only names the framework may register on MCP's model-controlled Tool plane. */
export type GatewayName = (typeof GATEWAY_TOOL_NAMES)[number];
