import {
  compileApplication,
  compileDisclosureApplication,
  type ApplicationCompilation,
  type CompiledApplication,
} from '../core/model/compiler.js';
import { Disclosure } from '../core/model/disclosure.js';
import { ApplicationRuntime } from '../core/model/runtime.js';
import { InMemoryTelemetry } from '../core/model/telemetry.js';
import type { Telemetry } from '../core/model/telemetry.js';
import { ExecutionAPI } from '../core/model/system-api.js';
import { Gateway } from '../core/model/system-api.js';
import { normalizeApplication } from '../application.js';
import { Publications } from './surface/publications.js';
import { createContextureMcpServer, type ContextureMcpServer } from './index.js';

/** The coordinated runtime projections that share one bound compiled Index. */
export interface RuntimeApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly runtime: ApplicationRuntime;
  readonly execution: ExecutionAPI;
  readonly publications: Publications;
  readonly telemetry: Telemetry;
}

/** The independently compiled projection that deliberately cannot execute. */
export interface DisclosureApplication {
  readonly index: CompiledApplication;
  readonly disclosure: Disclosure;
  readonly publications: Publications;
  readonly telemetry: Telemetry;
  server(): ContextureMcpServer;
}

/** Compile all runtime surfaces with Prompt reservations applied to model navigation. */
export function compileRuntimeApplication(declaration: ApplicationCompilation): RuntimeApplication {
  const normalized = normalizeApplication(declaration);
  const index = compileApplication(normalized);
  const telemetry = normalized.telemetry ?? new InMemoryTelemetry();
  const disclosure = new Disclosure(index, {
    reserved: reservedPromptRefs(normalized),
    telemetry,
  });
  const runtime = new ApplicationRuntime(index, { telemetry });
  const execution = new ExecutionAPI(runtime);
  return Object.freeze({
    index,
    disclosure,
    runtime,
    execution,
    telemetry,
    publications: new Publications(disclosure, runtime, normalized),
  });
}

/** Compile an independent disclosure-only surface with no execution lifecycle. */
export function compileStructuralApplication(
  declaration: ApplicationCompilation,
): DisclosureApplication {
  const normalized = normalizeApplication(declaration);
  const index = compileDisclosureApplication(normalized);
  const telemetry = normalized.telemetry ?? new InMemoryTelemetry();
  const disclosure = new Disclosure(index, {
    reserved: reservedPromptRefs(normalized),
    telemetry,
  });
  const application = {
    index,
    disclosure,
    telemetry,
    publications: new Publications(disclosure, undefined, normalized),
    server: (): ContextureMcpServer =>
      createContextureMcpServer(
        { name: index.name, version: '0.13.0rc1' },
        new Gateway(disclosure, undefined),
        application.publications,
      ),
  };
  return Object.freeze(application);
}

function reservedPromptRefs(
  declaration: Pick<ApplicationCompilation, 'prompts'>,
): readonly string[] {
  return Object.freeze(
    (declaration.prompts ?? [])
      .filter((prompt) => prompt.modelMayOpen === false)
      .map((prompt) => prompt.opens),
  );
}
