/**
 * Compatibility exports for the closed gateway vocabulary owned by
 * foundation. The model and this primitive projection must use the same
 * spellings without importing one another.
 */
export {
  DISCOVER_GATEWAY_NAME,
  GATEWAY_TOOL_NAMES,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
} from '../foundation/vocabulary.js';
export type { GatewayName } from '../foundation/vocabulary.js';
