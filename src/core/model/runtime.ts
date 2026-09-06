import { AsyncLocalStorage } from 'node:async_hooks';

import type { CompiledApplication, CompiledTool } from './compiler.js';
import {
  InputValidationError,
  ModelValidationError,
  NodeNotFoundError,
} from '../foundation/errors.js';
import type { Principal } from '../foundation/principal.js';
import { RefusedError } from './disclosure.js';
import { RootSelection, SelectedGraph } from './root-selection.js';
import type { ToolCallContext } from './declarations.js';
import { withChannels } from './channels.js';

/** Best-effort observability; it is never permitted to change an outcome. */
export interface Telemetry {
  record(event: TelemetryEvent): void | Promise<void>;
}

export interface TelemetryEvent {
  readonly ref: string;
  readonly failed: boolean;
  readonly at: Date;
}

/** Minimal deterministic telemetry suitable for local inspection and tests. */
export class InMemoryTelemetry implements Telemetry {
  readonly #events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this.#events.push(Object.freeze({ ...event }));
  }

  get events(): readonly TelemetryEvent[] {
    return Object.freeze([...this.#events]);
  }
}

interface RuntimeScope {
  readonly principal: Principal | undefined;
  readonly telemetry: Telemetry;
  readonly graph: SelectedGraph;
  readonly selection: RootSelection;
  readonly host: unknown;
  readonly signal: AbortSignal | undefined;
}

const SCOPE = new AsyncLocalStorage<RuntimeScope>();

function requireScope(): RuntimeScope {
  const scope = SCOPE.getStore();
  if (scope === undefined)
    throw new ModelValidationError('No Contexture Tool invocation is active.');
  return scope;
}

/** Request-local Contexture facts, available only while a Tool is running. */
export function currentPrincipal(): Principal | undefined {
  return requireScope().principal;
}

export function currentTelemetry(): Telemetry {
  return requireScope().telemetry;
}

export function currentGraph(): SelectedGraph {
  return requireScope().graph;
}

export function currentRootSelection(): RootSelection {
  return requireScope().selection;
}

/** Transport-neutral validated invocation over a bound compiled Index. */
export class ApplicationRuntime {
  readonly selection: RootSelection;
  readonly identityCeiling: RootSelection;
  readonly telemetry: Telemetry;

  constructor(
    readonly index: CompiledApplication,
    options: {
      readonly selection?: RootSelection;
      readonly identityCeiling?: RootSelection;
      readonly telemetry?: Telemetry;
    } = {},
  ) {
    if (!index.executionBound) {
      throw new ModelValidationError(
        'ApplicationRuntime requires a bound Index. A disclosure-only Index cannot be upgraded into execution.',
      );
    }
    this.selection = (options.selection ?? RootSelection.all()).resolve(index);
    this.identityCeiling = (options.identityCeiling ?? RootSelection.all()).resolve(index);
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    Object.freeze(this);
  }

  async invokeReadOnly(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    requested: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.invokeAtDoor(ref, arguments_, true, context, requested);
  }

  async invoke(
    ref: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    requested: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    return this.invokeAtDoor(ref, arguments_, false, context, requested);
  }

  /** Open application Channels around a Host serving lifetime. */
  async serve<Result>(operation: () => Promise<Result>): Promise<Result> {
    return withChannels(this.index.channels, operation);
  }

  private async invokeAtDoor(
    ref: string,
    arguments_: unknown,
    readOnly: boolean,
    context: ToolCallContext,
    requested: RootSelection,
  ): Promise<unknown> {
    const selection = this.identityCeiling
      .intersect(this.selection)
      .intersect(requested)
      .resolve(this.index);
    selection.requireRef(ref);
    const node = this.nodeAt(ref);
    if (node.readOnly !== readOnly) {
      const stated = node.readOnly ? 'read-only' : 'not read-only';
      const door = node.readOnly ? 'contexture_invoke_read_only' : 'contexture_invoke';
      throw new RefusedError(`${ref} is ${stated}, so it must be run through ${door}.`);
    }
    const scope: RuntimeScope = Object.freeze({
      principal: context.principal,
      telemetry: this.telemetry,
      graph: new SelectedGraph(this.index, selection),
      selection,
      host: context.host,
      signal: context.signal,
    });
    const callContext = Object.freeze({
      ...context,
      principal: scope.principal,
      telemetry: scope.telemetry,
      graph: scope.graph,
      selection: scope.selection,
    });
    try {
      const binding = node.binding;
      if (binding === undefined) {
        throw new ModelValidationError('A disclosure-only Tool cannot be invoked.');
      }
      const value = await SCOPE.run(scope, () => binding.call(arguments_, callContext));
      await report(this.telemetry, ref, false);
      return value;
    } catch (error) {
      await report(this.telemetry, ref, true);
      throw error;
    }
  }

  private nodeAt(ref: string): CompiledTool {
    let node;
    try {
      node = this.index.find(ref);
    } catch (error) {
      if (error instanceof ModelValidationError || error instanceof NodeNotFoundError) {
        throw new RefusedError(error.message);
      }
      throw error;
    }
    if (node.kind !== 'tool') {
      throw new RefusedError(
        `${ref} names a ${node.kind}, not a tool. Open it with contexture_open.`,
      );
    }
    return node;
  }
}

async function report(telemetry: Telemetry, ref: string, failed: boolean): Promise<void> {
  try {
    await telemetry.record(Object.freeze({ ref, failed, at: new Date() }));
  } catch {
    // Telemetry is an observer; a failed exporter cannot alter a business call.
  }
}

export { InputValidationError };
