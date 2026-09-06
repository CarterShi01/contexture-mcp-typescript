import {
  compileApplication,
  compileDisclosureApplication,
  type CompiledApplication,
} from '../core/model/compiler.js';
import { Disclosure } from '../core/model/disclosure.js';
import { ApplicationRuntime } from '../core/model/runtime.js';
import { InMemoryTelemetry } from '../core/model/telemetry.js';
import type { Telemetry } from '../core/model/telemetry.js';
import { defineApplication, type ApplicationDeclaration } from '../application.js';
import { Publications } from './surface/publications.js';

/** The coordinated runtime projections that share one bound compiled Index. */
export interface RuntimeApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly runtime: ApplicationRuntime;
  readonly publications: Publications;
  readonly telemetry: Telemetry;
}

/** The independently compiled projection that deliberately cannot execute. */
export interface DisclosureApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly publications: Publications;
  readonly telemetry: Telemetry;
}

/** Compile all runtime surfaces with Prompt reservations applied to model navigation. */
export function compileRuntimeApplication(declaration: ApplicationDeclaration): RuntimeApplication {
  const normalized = defineApplication(declaration);
  const index = compileApplication(normalized);
  const telemetry = normalized.telemetry ?? new InMemoryTelemetry();
  const disclosure = new Disclosure(index, {
    reserved: reservedPromptRefs(normalized),
    telemetry,
  });
  const runtime = new ApplicationRuntime(index, { telemetry });
  return Object.freeze({
    index,
    disclosure,
    runtime,
    telemetry,
    publications: new Publications(disclosure, runtime, normalized),
  });
}

/** Compile an independent disclosure-only surface with no execution lifecycle. */
export function compileStructuralApplication(
  declaration: ApplicationDeclaration,
): DisclosureApplication {
  const normalized = defineApplication(declaration);
  const index = compileDisclosureApplication(normalized);
  const telemetry = normalized.telemetry ?? new InMemoryTelemetry();
  const disclosure = new Disclosure(index, {
    reserved: reservedPromptRefs(normalized),
    telemetry,
  });
  return Object.freeze({
    index,
    disclosure,
    telemetry,
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
