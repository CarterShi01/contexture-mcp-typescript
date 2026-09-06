import type { ToolCallContext } from '../core/index.js';
import { ApplicationRuntime, ModelValidationError, RootSelection } from '../core/index.js';
import type { RestRoute } from './route.js';

/** Validated allowlist over the same Binding used by the Contexture gateway. */
export class RestRouter {
  readonly #routes: ReadonlyMap<string, RestRoute>;

  constructor(
    readonly runtime: ApplicationRuntime,
    routes: readonly RestRoute[],
  ) {
    const registered = new Map<string, RestRoute>();
    for (const route of routes) {
      validateRoute(runtime, route);
      const key = routeKey(route.method, route.path);
      if (registered.has(key))
        throw new ModelValidationError(`REST route ${key} is declared more than once.`);
      registered.set(key, Object.freeze({ ...route }));
    }
    this.#routes = registered;
    Object.freeze(this);
  }

  get routes(): readonly RestRoute[] {
    return Object.freeze([...this.#routes.values()]);
  }

  async handle(
    method: string,
    path: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    const route = this.#routes.get(routeKey(method, path));
    if (route === undefined)
      throw new ModelValidationError('No Contexture REST route matches this method and path.');
    return isReadMethod(route.method)
      ? this.runtime.invokeReadOnly(route.ref, arguments_, context, selection)
      : this.runtime.invoke(route.ref, arguments_, context, selection);
  }
}

function validateRoute(runtime: ApplicationRuntime, route: RestRoute): void {
  if (!route.path.startsWith('/'))
    throw new ModelValidationError('A Contexture REST route path must begin with /.');
  const node = runtime.index.find(route.ref);
  if (node.kind !== 'tool')
    throw new ModelValidationError(`REST route ${route.path} must target a Tool.`);
  if (isReadMethod(route.method) !== node.readOnly) {
    throw new ModelValidationError(
      `REST route ${route.method} ${route.path} uses a ${isReadMethod(route.method) ? 'read' : 'writing'} method for a ${node.readOnly ? 'read-only' : 'writing'} Tool.`,
    );
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}
