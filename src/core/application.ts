import {
  compileApplication,
  compileDisclosureApplication,
  type CompiledApplication,
} from './compiler.js';
import type { ApplicationDeclaration } from './declarations.js';
import { Disclosure } from './disclosure.js';
import { Publications } from './publications.js';
import { ApplicationRuntime } from './runtime.js';

/** The coordinated runtime projections that share one bound compiled Index. */
export interface RuntimeApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly runtime: ApplicationRuntime;
  readonly publications: Publications;
}

/** The independently compiled projection that deliberately cannot execute. */
export interface DisclosureApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly publications: Publications;
}

/** Compile all runtime surfaces with Prompt reservations applied to model navigation. */
export function compileRuntimeApplication(declaration: ApplicationDeclaration): RuntimeApplication {
  const index = compileApplication(declaration);
  const disclosure = new Disclosure(index, { reserved: reservedPromptRefs(declaration) });
  const runtime = new ApplicationRuntime(index);
  return Object.freeze({
    index,
    disclosure,
    runtime,
    publications: new Publications(disclosure, runtime, declaration),
  });
}

/** Compile an independent disclosure-only surface with no execution lifecycle. */
export function compileStructuralApplication(
  declaration: ApplicationDeclaration,
): DisclosureApplication {
  const index = compileDisclosureApplication(declaration);
  const disclosure = new Disclosure(index, { reserved: reservedPromptRefs(declaration) });
  return Object.freeze({
    index,
    disclosure,
    publications: new Publications(disclosure, undefined, declaration),
  });
}

function reservedPromptRefs(declaration: ApplicationDeclaration): readonly string[] {
  return Object.freeze(
    (declaration.prompts ?? [])
      .filter((prompt) => prompt.modelMayOpen === false)
      .map((prompt) => prompt.opens),
  );
}
