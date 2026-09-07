/** Immutable identity facts for one Contexture request. */
export interface PrincipalOptions {
  readonly subject?: string;
  readonly clientId?: string;
  readonly issuer?: string;
  readonly scopes?: Iterable<string>;
  readonly claims?: Readonly<Record<string, unknown>>;
}

// Node's util.inspect looks up this global symbol. Keeping the symbol local
// avoids making declaration-only package consumers depend on @types/node.
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * The caller identity a Host has authenticated for one request.
 *
 * Contexture intentionally records identity but does not interpret it as an
 * authorization policy. Tools decide what their application permits.
 */
export class Principal {
  readonly subject: string | undefined;
  readonly clientId: string | undefined;
  readonly issuer: string | undefined;
  readonly scopes: ReadonlySet<string>;
  readonly claims: Readonly<Record<string, unknown>>;

  constructor(options: PrincipalOptions = {}) {
    this.subject = options.subject;
    this.clientId = options.clientId;
    this.issuer = options.issuer;
    this.scopes = immutableStringSet(options.scopes ?? []);
    this.claims = Object.freeze({ ...(options.claims ?? {}) });
    Object.freeze(this);
  }

  /** Return safe identity facts for JSON logs and diagnostics, never raw token claims. */
  toJSON(): Readonly<{
    readonly subject: string | undefined;
    readonly clientId: string | undefined;
    readonly issuer: string | undefined;
    readonly scopes: readonly string[];
  }> {
    return Object.freeze({
      subject: this.subject,
      clientId: this.clientId,
      issuer: this.issuer,
      scopes: Object.freeze([...this.scopes].sort(compareCodePoints)),
    });
  }

  /** Keep Node's inspect and console output on the same redacted identity plane. */
  [NODE_INSPECT](): string {
    return `Principal ${JSON.stringify(this.toJSON())}`;
  }

  toString(): string {
    const identity = this.toJSON();
    return `Principal(subject=${JSON.stringify(identity.subject)}, clientId=${JSON.stringify(identity.clientId)}, issuer=${JSON.stringify(identity.issuer)}, scopes=${JSON.stringify(identity.scopes)})`;
  }
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference =
      (leftPoints[index]?.codePointAt(0) ?? 0) - (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function immutableStringSet(values: Iterable<string>): ReadonlySet<string> {
  const contents = new Set(values);
  return Object.freeze({
    get size() {
      return contents.size;
    },
    has(value: string) {
      return contents.has(value);
    },
    entries() {
      return contents.entries();
    },
    keys() {
      return contents.keys();
    },
    values() {
      return contents.values();
    },
    forEach(callback: (value: string, valueAgain: string, set: ReadonlySet<string>) => void) {
      contents.forEach((value) => callback(value, value, this));
    },
    [Symbol.iterator]() {
      return contents.values();
    },
  }) as ReadonlySet<string>;
}
