import { AsyncLocalStorage } from 'node:async_hooks';

import type { CompiledApplication, CompiledTool } from './compiler.js';
import { InputValidationError, ModelValidationError } from '../foundation/errors.js';
import type { Principal } from '../foundation/principal.js';
import { RootSelection, SelectedGraph } from './root-selection.js';
import type { ToolCallContext } from './declarations.js';
import { withChannels } from './channels.js';
import { InMemoryTelemetry, reportTelemetry, type Telemetry } from './telemetry.js';

export { InMemoryTelemetry, reportTelemetry } from './telemetry.js';
export type { NodeUsage, Telemetry, TelemetryEvent } from './telemetry.js';

interface RuntimeScope {
  readonly principal: Principal | undefined;
  readonly telemetry: Telemetry;
  readonly graph: SelectedGraph;
  readonly selection: RootSelection;
  readonly host: unknown;
  readonly signal: AbortSignal | undefined;
}

const SCOPE = new AsyncLocalStorage<RuntimeScope>();

/** A Tool reached the invocation door whose fixed host hint does not match it. */
export class WrongDoorError extends Error {
  override readonly name = 'WrongDoorError';

  constructor(
    readonly ref: string,
    readonly readOnly: boolean,
  ) {
    super(`${ref} was called through the wrong Contexture invocation door.`);
  }
}

function requireScope(): RuntimeScope {
  const scope = SCOPE.getStore();
  if (scope === undefined)
    throw new ModelValidationError('No Contexture Tool invocation is active.');
  return scope;
}

/**
 * The caller identity for this invocation, or `undefined` when none exists.
 *
 * An unauthenticated Tool call and code outside an invocation are both an
 * absent identity. Contexture deliberately does not invent an "anonymous"
 * Principal: an application owns the decision whether identity is required.
 */
export function currentPrincipal(): Principal | undefined {
  return SCOPE.getStore()?.principal;
}

export function currentTelemetry(): Telemetry {
  return requireScope().telemetry;
}

export function currentGraph(): SelectedGraph {
  return requireScope().graph;
}

export function currentRootSelection(): RootSelection {
  // Root selection is also a compatibility fact outside a Tool invocation:
  // without a request-local attenuation, callers see the all-roots surface.
  return SCOPE.getStore()?.selection ?? RootSelection.all();
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
      throw new WrongDoorError(ref, node.readOnly);
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
      channels: this.index.channels,
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
      await reportTelemetry(this.telemetry, ref);
      return value;
    } catch (error) {
      await reportTelemetry(this.telemetry, ref, true);
      throw error;
    }
  }

  private nodeAt(ref: string): CompiledTool {
    return this.index.tool(ref);
  }
}

export { InputValidationError };
