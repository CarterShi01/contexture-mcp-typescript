import type { Channels, Factory, NodeDeclaration } from './core/model/declarations.js';
import type { PromptDeclaration } from './core/mcp-interface/prompt.js';
import type { ResourceDeclaration } from './core/mcp-interface/resource.js';

/** The lazy application composition root. */
export interface ApplicationDeclaration {
  readonly name: string;
  readonly roots: readonly Factory<NodeDeclaration>[];
  readonly promptRoots?: readonly Factory<NodeDeclaration>[];
  readonly channels?: Channels;
  readonly prompts?: readonly PromptDeclaration[];
  readonly resources?: readonly ResourceDeclaration[];
}

/**
 * Declare an application without constructing nodes, opening dependencies, or
 * compiling an Index.
 */
export function defineApplication(declaration: ApplicationDeclaration): ApplicationDeclaration {
  if (typeof declaration.name !== 'string' || declaration.name.trim().length === 0) {
    throw new TypeError('Application name must not be empty.');
  }
  if (!Array.isArray(declaration.roots) || declaration.roots.length === 0) {
    throw new TypeError('Application must declare at least one model-visible root.');
  }
  if (declaration.roots.some((factory) => typeof factory !== 'function')) {
    throw new TypeError('Application roots must be lazy factories.');
  }
  if (
    declaration.promptRoots !== undefined &&
    (!Array.isArray(declaration.promptRoots) ||
      declaration.promptRoots.some((factory) => typeof factory !== 'function'))
  ) {
    throw new TypeError('Application promptRoots must be lazy factories.');
  }

  return Object.freeze({
    name: declaration.name,
    roots: Object.freeze([...declaration.roots]),
    ...(declaration.promptRoots === undefined
      ? {}
      : { promptRoots: Object.freeze([...declaration.promptRoots]) }),
    ...(declaration.channels === undefined ? {} : { channels: declaration.channels }),
    ...(declaration.prompts === undefined
      ? {}
      : {
          prompts: Object.freeze(declaration.prompts.map((prompt) => Object.freeze({ ...prompt }))),
        }),
    ...(declaration.resources === undefined
      ? {}
      : {
          resources: Object.freeze(
            declaration.resources.map((resource) => Object.freeze({ ...resource })),
          ),
        }),
  });
}

/** Python's `Contexture(...)` declaration concept, expressed as a native factory. */
export function Contexture(declaration: ApplicationDeclaration): ApplicationDeclaration {
  return defineApplication(declaration);
}
