import { AsyncLocalStorage } from 'node:async_hooks';

import { ModelValidationError } from '../foundation/errors.js';
import type { SelectedGraph } from './root-selection.js';

const CURRENT_GRAPH = new AsyncLocalStorage<SelectedGraph>();

/** Return the exact immutable graph bound to the current asynchronous scope. */
export function currentGraph(): SelectedGraph {
  const graph = CURRENT_GRAPH.getStore();
  if (graph === undefined) {
    throw new ModelValidationError(
      'No compiled Contexture graph is active. Use currentGraph() only inside Tool.invoke() or withGraph().',
    );
  }
  return graph;
}

/**
 * Run one framework-owned operation with a task-local compiled graph.
 *
 * Nested scopes restore their parent automatically, including across awaits and
 * failures. ApplicationRuntime installs its authoritative selected graph over
 * any caller scope before invoking a Tool.
 */
export function withGraph<Result>(graph: SelectedGraph, operation: () => Result): Result {
  return CURRENT_GRAPH.run(graph, operation);
}
