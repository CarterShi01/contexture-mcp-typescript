import type { Channels, CleanupRegistrar } from './declarations.js';

/** Hold application dependencies open around one served operation. */
export async function withChannels<Result>(
  channels: Channels | undefined,
  serve: () => Promise<Result>,
): Promise<Result> {
  if (channels === undefined) return serve();
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
  const target = primary as { suppressed?: unknown[] };
  target.suppressed ??= [];
  target.suppressed.push(cleanup);
}
