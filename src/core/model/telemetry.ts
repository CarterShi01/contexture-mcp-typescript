import { AsyncLocalStorage } from 'node:async_hooks';

import { ModelValidationError } from '../foundation/errors.js';

/** Framework-owned aggregate for one opened Role/Skill or invoked Tool. */
export interface NodeUsage {
  readonly ref: string;
  readonly callCount: number;
  readonly errorCount: number;
  readonly lastUsedAt: string | undefined;
}

/** One immutable observation retained by collectors that support diagnostics. */
export interface TelemetryEvent {
  readonly ref: string;
  readonly failed: boolean;
  readonly occurredAt: string;
}

/** Replaceable side channel; failures never alter Contexture outcomes. */
export interface Telemetry {
  record(event: TelemetryEvent): void | Promise<void>;
  usage(ref: string): NodeUsage;
}

const CURRENT_TELEMETRY = new AsyncLocalStorage<Telemetry>();

/** Return the collector bound to the current Tool invocation or explicit scope. */
export function currentTelemetry(): Telemetry {
  const telemetry = CURRENT_TELEMETRY.getStore();
  if (telemetry === undefined) {
    throw new ModelValidationError('No Contexture telemetry is active.');
  }
  return telemetry;
}

/** Run one operation with a task-local telemetry collector, restoring any outer scope. */
export function withTelemetry<Result>(telemetry: Telemetry, operation: () => Result): Result {
  return CURRENT_TELEMETRY.run(telemetry, operation);
}

/** Process-local, lossless aggregate and event collector. */
export class InMemoryTelemetry implements Telemetry {
  readonly #usage = new Map<string, NodeUsage>();
  readonly #events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    const occurredAt = event.occurredAt || new Date().toISOString();
    const snapshot = Object.freeze({ ref: event.ref, failed: event.failed, occurredAt });
    const previous = this.#usage.get(event.ref) ?? emptyUsage(event.ref);
    this.#usage.set(
      event.ref,
      Object.freeze({
        ref: event.ref,
        callCount: previous.callCount + 1,
        errorCount: previous.errorCount + (event.failed ? 1 : 0),
        lastUsedAt: occurredAt,
      }),
    );
    this.#events.push(snapshot);
  }

  usage(ref: string): NodeUsage {
    return this.#usage.get(ref) ?? emptyUsage(ref);
  }

  get events(): readonly TelemetryEvent[] {
    return Object.freeze([...this.#events]);
  }
}

/** Observe one use without allowing exporter rejection or a synchronous throw to escape. */
export async function reportTelemetry(
  telemetry: Telemetry,
  ref: string,
  failed = false,
): Promise<void> {
  try {
    await telemetry.record(Object.freeze({ ref, failed, occurredAt: new Date().toISOString() }));
  } catch {
    // Telemetry is evidence, never a business dependency.
  }
}

function emptyUsage(ref: string): NodeUsage {
  return Object.freeze({ ref, callCount: 0, errorCount: 0, lastUsedAt: undefined });
}
