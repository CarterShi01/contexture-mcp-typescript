import {
  compileApplication,
  compileDisclosureApplication,
  type CompiledApplication,
} from '../core/model/compiler.js';
import { Disclosure } from '../core/model/disclosure.js';
import { ApplicationRuntime } from '../core/model/runtime.js';
import { defineApplication, type ApplicationDeclaration } from '../application.js';
import { Publications } from './surface/publications.js';

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
  const normalized = defineApplication(declaration);
  const index = compileApplication(normalized);
  const disclosure = new Disclosure(index, { reserved: reservedPromptRefs(normalized) });
  const runtime = new ApplicationRuntime(index);
  return Object.freeze({
    index,
    disclosure,
    runtime,
    publications: new Publications(disclosure, runtime, normalized),
  });
}

/** Compile an independent disclosure-only surface with no execution lifecycle. */
export function compileStructuralApplication(
  declaration: ApplicationDeclaration,
): DisclosureApplication {
  const normalized = defineApplication(declaration);
  const index = compileDisclosureApplication(normalized);
  const disclosure = new Disclosure(index, { reserved: reservedPromptRefs(normalized) });
  return Object.freeze({
    index,
    disclosure,
    publications: new Publications(disclosure, undefined, normalized),
  });
}

function reservedPromptRefs(declaration: ApplicationDeclaration): readonly string[] {
  return Object.freeze(
    (declaration.prompts ?? [])
      .filter((prompt) => prompt.modelMayOpen === false)
      .map((prompt) => prompt.opens),
  );
}
