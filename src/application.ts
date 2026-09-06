import type { Channels, Factory, NodeDeclaration } from './core/model/declarations.js';
import type { PromptDeclaration } from './core/mcp-interface/prompt.js';
import type { ResourceDeclaration } from './core/mcp-interface/resource.js';
import type { Telemetry } from './core/model/telemetry.js';

/** The lazy application composition root. */
export interface ApplicationDeclaration {
  readonly name: string;
  readonly roots: readonly Factory<NodeDeclaration>[];
  readonly promptRoots?: readonly Factory<NodeDeclaration>[];
  readonly channels?: Channels;
  readonly prompts?: readonly PromptDeclaration[];
  readonly resources?: readonly ResourceDeclaration[];
  readonly telemetry?: Telemetry;
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
  const prompts = snapshotPrompts(declaration.prompts);
  const resources = snapshotResources(declaration.resources);
  if (
    declaration.telemetry !== undefined &&
    (typeof declaration.telemetry !== 'object' ||
      declaration.telemetry === null ||
      typeof declaration.telemetry.record !== 'function' ||
      typeof declaration.telemetry.usage !== 'function')
  ) {
    throw new TypeError('Application telemetry must implement record and usage.');
  }

  return Object.freeze({
    name: declaration.name.trim(),
    roots: Object.freeze([...declaration.roots]),
    ...(declaration.promptRoots === undefined
      ? {}
      : { promptRoots: Object.freeze([...declaration.promptRoots]) }),
    ...(declaration.channels === undefined ? {} : { channels: declaration.channels }),
    ...(prompts === undefined ? {} : { prompts }),
    ...(resources === undefined ? {} : { resources }),
    ...(declaration.telemetry === undefined ? {} : { telemetry: declaration.telemetry }),
  });
}

/** Python's `Contexture(...)` declaration concept, expressed as a native factory. */
export function Contexture(declaration: ApplicationDeclaration): ApplicationDeclaration {
  return defineApplication(declaration);
}

function snapshotPrompts(
  declarations: readonly PromptDeclaration[] | undefined,
): readonly PromptDeclaration[] | undefined {
  if (declarations === undefined) return undefined;
  if (!Array.isArray(declarations)) throw new TypeError('Application prompts must be an array.');
  return Object.freeze(
    declarations.map((prompt, index) => {
      if (typeof prompt !== 'object' || prompt === null || Array.isArray(prompt)) {
        throw new TypeError(`Application prompt ${index} must be an object.`);
      }
      requireDeclarationText(prompt.opens, `Application prompt ${index} opens`);
      requireDeclarationText(prompt.description, `Application prompt ${index} description`);
      if (prompt.name !== undefined)
        requireDeclarationText(prompt.name, `Application prompt ${index} name`);
      if (prompt.modelMayOpen !== undefined && typeof prompt.modelMayOpen !== 'boolean') {
        throw new TypeError(`Application prompt ${index} modelMayOpen must be a boolean.`);
      }
      return Object.freeze({ ...prompt });
    }),
  );
}

function snapshotResources(
  declarations: readonly ResourceDeclaration[] | undefined,
): readonly ResourceDeclaration[] | undefined {
  if (declarations === undefined) return undefined;
  if (!Array.isArray(declarations)) throw new TypeError('Application resources must be an array.');
  return Object.freeze(
    declarations.map((resource, index) => {
      if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
        throw new TypeError(`Application resource ${index} must be an object.`);
      }
      requireDeclarationText(resource.opens, `Application resource ${index} opens`);
      requireDeclarationText(resource.uri, `Application resource ${index} uri`);
      requireDeclarationText(resource.description, `Application resource ${index} description`);
      if (resource.name !== undefined)
        requireDeclarationText(resource.name, `Application resource ${index} name`);
      if (resource.mimeType !== undefined && typeof resource.mimeType !== 'string') {
        throw new TypeError(`Application resource ${index} mimeType must be a string.`);
      }
      return Object.freeze({ ...resource });
    }),
  );
}

function requireDeclarationText(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${subject} must not be empty.`);
  }
}
