/** WP11 candidate syntax only: a parsed reference never grants authority. */
import { GraphError, validateID } from './canonical.js';

export const MAX_REFERENCE_BYTES = 1024;

function invalid(): never {
  throw new GraphError('schema_invalid', 'Invalid canonical managed reference');
}

function generation(value: unknown): string {
  // Deliberately no UUID version/variant restriction: nil and unknown builds
  // remain syntactically valid, with admission/freshness owned by a future Host.
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    invalid();
  return value;
}

function encode(value: unknown): string {
  return Buffer.from(validateID(value), 'utf8').toString('base64url');
}

function decode(value: string): string {
  if (value.length > 342 || !/^[A-Za-z0-9_-]+$/.test(value) || value.endsWith('\n')) invalid();
  let identity: string;
  try {
    identity = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(value, 'base64url'),
    );
    validateID(identity);
  } catch {
    return invalid();
  }
  // Node's decoder is permissive: re-encoding checks length and unused pad bits.
  if (encode(identity) !== value) invalid();
  return identity;
}

export class ManagedReference {
  readonly graphID: string;
  readonly generationUUID: string;
  readonly nodeID: string;

  constructor(graphID: unknown, generationUUID: unknown, nodeID: unknown) {
    this.graphID = validateID(graphID);
    this.generationUUID = generation(generationUUID);
    this.nodeID = validateID(nodeID);
    Object.freeze(this);
  }

  toString(): string {
    return formatReference(this.graphID, this.generationUUID, this.nodeID);
  }
}

export function formatReference(
  graphID: unknown,
  generationUUID: unknown,
  nodeID: unknown,
): string {
  const wire = `ctxg:v1:${encode(graphID)}:${generation(generationUUID)}:${encode(nodeID)}`;
  if (wire.length > MAX_REFERENCE_BYTES) invalid();
  return wire;
}

export function parseReference(value: unknown): ManagedReference {
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_BYTES) invalid();
  if ([...value].some((character) => character.charCodeAt(0) > 0x7f)) invalid();
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'ctxg' || parts[1] !== 'v1') invalid();
  const result = new ManagedReference(decode(parts[2]!), generation(parts[3]), decode(parts[4]!));
  if (result.toString() !== value) invalid();
  return result;
}
