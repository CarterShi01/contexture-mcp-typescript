/** Any deployment dependency captured by an imperative ControllerManager. */
export type ChannelHandle = unknown;

/**
 * Application-wide dependencies with an explicitly managed lifetime.
 *
 * This is deliberately a nominal runtime class rather than a structural
 * `{ open, close }` interface. An ordinary deployment handle may happen to
 * contain methods with those names; Contexture must still pass it through
 * unchanged. Only an instance of this class participates in a lifecycle.
 */
export abstract class Channels {
  /** A protected nominal marker; structurally similar raw values stay raw. */
  declare protected readonly __contextureChannelsLifecycle: void;

  abstract open(registrar: CleanupRegistrar): void | Promise<void>;
  abstract close(): void | Promise<void>;
}

/** Register cleanup immediately after acquiring a dependency. */
export interface CleanupRegistrar {
  defer(cleanup: () => void | Promise<void>): void;
}

/** Hold application dependencies open around one served operation. */
export async function withChannels<Result>(
  channels: ChannelHandle | undefined,
  serve: () => Promise<Result>,
): Promise<Result> {
  if (!(channels instanceof Channels)) return serve();
  const cleanups: Array<() => void | Promise<void>> = [];
  const registrar: CleanupRegistrar = Object.freeze({
    defer(cleanup: () => void | Promise<void>): void {
      cleanups.push(cleanup);
    },
  });
  let opened = false;
  let primary: unknown;
  let result: Result | undefined;
  try {
    await channels.open(registrar);
    opened = true;
    result = await serve();
  } catch (error) {
    primary = error;
  }
  if (opened) {
    try {
      await channels.close();
    } catch (error) {
      if (primary === undefined) primary = error;
      else attachSuppressed(primary, error);
    }
  }
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      if (primary === undefined) primary = error;
      else attachSuppressed(primary, error);
    }
  }
  if (primary !== undefined) throw primary;
  return result as Result;
}

function attachSuppressed(primary: unknown, cleanup: unknown): void {
  if (typeof primary !== 'object' || primary === null) return;
  const target = primary as { suppressed?: readonly unknown[] };
  try {
    Object.defineProperty(target, 'suppressed', {
      configurable: true,
      value: Object.freeze([...(target.suppressed ?? []), cleanup]),
    });
  } catch {
    // A frozen primary error still remains the primary error. Suppression
    // metadata is best-effort and must never replace the failure being served.
  }
}
