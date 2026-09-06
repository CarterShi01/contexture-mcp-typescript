/** Immutable identity facts for one Contexture request. */
export interface PrincipalOptions {
  readonly subject?: string;
  readonly clientId?: string;
  readonly issuer?: string;
  readonly scopes?: Iterable<string>;
  readonly claims?: Readonly<Record<string, unknown>>;
}

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

  toString(): string {
    return `Principal(subject=${JSON.stringify(this.subject)}, clientId=${JSON.stringify(this.clientId)}, issuer=${JSON.stringify(this.issuer)}, scopes=${JSON.stringify([...this.scopes].sort())})`;
  }
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
