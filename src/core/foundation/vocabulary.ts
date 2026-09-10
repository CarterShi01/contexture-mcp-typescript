/**
 * Framework vocabulary shared by declaration, model, MCP-primitive, and Host
 * layers. These facts belong below those layers so a consumer never needs to
 * import a sibling merely to spell a Contexture reference or gateway name.
 */

/** Framework metadata, distinct from an application's MCP server identity. */
export const PACKAGE_NAME = 'contexture' as const;

/** This binding's release version, distinct from the specification version. */
export const PACKAGE_VERSION = '0.13.0rc1' as const;

/** Separates canonical Contexture reference segments. */
export const REFERENCE_SEPARATOR = '/' as const;

/** One immutable Contexture system Tool on MCP's model-controlled plane. */
export type GatewayName =
  | typeof DISCOVER_GATEWAY_NAME
  | typeof OPEN_GATEWAY_NAME
  | typeof INVOKE_READ_ONLY_GATEWAY_NAME
  | typeof INVOKE_GATEWAY_NAME;

/** The fixed gateway entry points; business Tools travel in their payloads. */
export const DISCOVER_GATEWAY_NAME = 'contexture_discover' as const;
export const OPEN_GATEWAY_NAME = 'contexture_open' as const;
export const INVOKE_READ_ONLY_GATEWAY_NAME = 'contexture_invoke_read_only' as const;
export const INVOKE_GATEWAY_NAME = 'contexture_invoke' as const;

/** The closed gateway vocabulary in registration order. */
export const GATEWAY_TOOL_NAMES: readonly GatewayName[] = Object.freeze([
  DISCOVER_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  INVOKE_GATEWAY_NAME,
]);
