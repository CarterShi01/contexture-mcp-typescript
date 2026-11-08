/** Structural Host metadata/lifecycles: no SDK or ambient Node declaration dependency. */
export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
}

/** A live streamable-HTTP Contexture server that its caller may close. */
export interface HttpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** Public lifecycle shape; the managed adapter separately verifies the actual SDK transport. */
export interface StdioTransportLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Connection lifecycle only; SDK registration, protocol and transport internals stay private. */
export interface McpConnectionLifecycle {
  close(): Promise<void>;
}
