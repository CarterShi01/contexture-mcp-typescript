#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { asJson, everyRef, render, trace } from '../inspection.js';
import { app as demoApplication } from '../demo/server.js';
import { compileRuntimeApplication } from '../server/application.js';
import { buildInstructions } from '../server/instructions.js';
import { buildServer, ContextureOptions, ServeError } from '../server/index.js';

import { findProject, loadApplication } from './project.js';
import { newProject } from './scaffold.js';
import { UsageError } from './usage.js';

export const CLI_VERSION = '0.12.0rc1';

export interface CliOutput {
  readonly out: (line: string) => void;
  readonly error: (line: string) => void;
}

/** Controlled process facts for native CLI tests and embedding. */
export interface CliEnvironment {
  readonly cwd?: string;
}

const processOutput: CliOutput = {
  out: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

/** Execute Contexture's local declaration, inspection, and invocation workflows. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  output: CliOutput = processOutput,
  environment: CliEnvironment = {},
): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === '--version') {
      output.out(CLI_VERSION);
      return 0;
    }
    const [command, ...arguments_] = argv;
    switch (command) {
      case 'new':
        return await commandNew(arguments_, output, environment);
      case 'list':
        return await commandList(arguments_, output, environment);
      case 'check':
        return await commandCheck(arguments_, output, environment);
      case 'call':
        return await commandCall(arguments_, output, environment);
      case 'inspect':
        return await commandInspect(arguments_, output, environment);
      case 'serve':
        return await commandServe(arguments_, output, environment);
      case 'demo':
        return await commandDemo(arguments_, output);
      default:
        throw new UsageError(usage());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contexture command failed.';
    output.error(`contexture: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

async function commandNew(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name.startsWith('-'))
    throw new UsageError('contexture new needs a project name.');
  let destination: string | undefined;
  let template = 'project';
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const value = rest[index + 1];
    if ((option !== '--into' && option !== '--template') || value === undefined)
      throw new UsageError('Use contexture new NAME [--into DIR] [--template NAME].');
    if (option === '--into') {
      if (destination !== undefined) throw new UsageError('Use --into at most once.');
      destination = value;
    } else {
      if (template !== 'project') throw new UsageError('Use --template at most once.');
      template = value;
    }
    index += 1;
  }
  if (template !== 'project')
    throw new UsageError(`Unknown template ${JSON.stringify(template)}. Available: project.`);
  const effectiveDestination = destination ?? environment.cwd;
  const root = await newProject(
    name,
    effectiveDestination === undefined ? {} : { destination: effectiveDestination },
  );
  output.out(`Wrote ${root}`);
  output.out('Next: npm install && npm run check');
  return 0;
}

async function commandList(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const application = await compiled(oneTarget(argv, 'list'), environment);
  for (const [ref, node] of application.index.walk()) {
    const indent = '  '.repeat(ref.split('/').length - 1);
    if (node.kind === 'role') output.out(`${indent}${node.name}  — ${node.description}`);
    if (node.kind === 'skill') output.out(`${indent}  skill     ${ref}`);
    if (node.kind === 'tool')
      output.out(
        `${indent}  tool      ${ref}  (${node.readOnly ? 'read-only' : 'needs approval'})`,
      );
  }
  return 0;
}

async function commandCheck(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const application = await compiled(oneTarget(argv, 'check'), environment);
  output.out(
    `OK ${application.index.name}: ${application.index.ofKind('role').length} role(s), ` +
      `${application.index.ofKind('skill').length} skill(s), ${application.index.ofKind('tool').length} tool(s)`,
  );
  return 0;
}

async function commandCall(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const [ref, ...rest] = argv;
  if (ref === undefined || ref.startsWith('-'))
    throw new UsageError('contexture call needs a Tool ref.');
  let input: string | undefined;
  let inputFile: string | undefined;
  let target: string | undefined;
  let allowWrite = false;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--allow-write') {
      if (allowWrite) throw new UsageError('Use --allow-write at most once.');
      allowWrite = true;
      continue;
    }
    const value = rest[index + 1];
    if (
      (option !== '--input' && option !== '--input-file' && option !== '--target') ||
      value === undefined
    )
      throw new UsageError(
        'Use contexture call REF [--input JSON | --input-file FILE] [--allow-write] [--target TARGET].',
      );
    if (option === '--input') {
      if (input !== undefined) throw new UsageError('Use --input at most once.');
      input = value;
    } else if (option === '--input-file') {
      if (inputFile !== undefined) throw new UsageError('Use --input-file at most once.');
      inputFile = value;
    } else {
      if (target !== undefined) throw new UsageError('Use --target at most once.');
      target = value;
    }
    index += 1;
  }
  if (input !== undefined && inputFile !== undefined)
    throw new UsageError('Pass either --input or --input-file, not both.');
  const arguments_ = await inputObject(input, inputFile);
  const application = await compiled(target, environment);
  let node;
  try {
    node = application.index.find(ref);
  } catch {
    throw new UsageError(
      `Cannot find Tool ${JSON.stringify(ref)}. Run contexture list, or inspect a Role for its Tool refs.`,
    );
  }
  if (node.kind !== 'tool')
    throw new UsageError(
      `${ref} is a ${node.kind}, not a Tool. Inspect it with contexture inspect ${ref}.`,
    );
  if (!node.readOnly && !allowWrite) {
    throw new UsageError(
      `${ref} is not read-only. Re-run with --allow-write only when you intend this local call to change external state.`,
    );
  }
  const value = await application.runtime.serve(() =>
    node.readOnly
      ? application.runtime.invokeReadOnly(ref, arguments_)
      : application.runtime.invoke(ref, arguments_),
  );
  output.out(typeof value === 'string' ? value : JSON.stringify(value));
  return 0;
}

async function commandInspect(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const refs: string[] = [];
  let target: string | undefined;
  let all = false;
  let read = false;
  let summary = false;
  let json = false;
  let discover = true;
  let rosterBudget: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === undefined) throw new UsageError('Unexpected empty command argument.');
    if (!item.startsWith('--')) {
      refs.push(item);
      continue;
    }
    if (item === '--all') {
      if (all) throw new UsageError('Use --all at most once.');
      all = true;
      continue;
    }
    if (item === '--read') {
      if (read) throw new UsageError('Use --read at most once.');
      read = true;
      continue;
    }
    if (item === '--summary') {
      if (summary) throw new UsageError('Use --summary at most once.');
      summary = true;
      continue;
    }
    if (item === '--json') {
      if (json) throw new UsageError('Use --json at most once.');
      json = true;
      continue;
    }
    if (item === '--no-discover') {
      if (!discover) throw new UsageError('Use --no-discover at most once.');
      discover = false;
      continue;
    }
    const value = argv[index + 1];
    if ((item !== '--target' && item !== '--roster-budget') || value === undefined)
      throw new UsageError(
        'Use contexture inspect [REF ...] [--target TARGET] [--all] [--read] [--summary] [--json] [--no-discover] [--roster-budget CHARS].',
      );
    if (item === '--target') {
      if (target !== undefined) throw new UsageError('Use --target at most once.');
      target = value;
    } else {
      if (rosterBudget !== undefined) throw new UsageError('Use --roster-budget at most once.');
      rosterBudget = Number(value);
      if (!Number.isInteger(rosterBudget) || rosterBudget < 0)
        throw new UsageError('--roster-budget must be a non-negative integer.');
    }
    index += 1;
  }
  if (all && refs.length > 0) throw new UsageError('Pass named refs or --all, not both.');
  const useDemo = target === undefined && (await findProject(environment.cwd)) === undefined;
  if (useDemo) output.error('No Contexture project was found, so this is the bundled demo.');
  const application = useDemo
    ? compileRuntimeApplication(demoApplication)
    : await compiled(target, environment);
  const selected = all ? [...everyRef(application.disclosure)] : refs;
  const operation = () =>
    trace(application.disclosure, selected, {
      instructions: buildInstructions(
        application.disclosure,
        rosterBudget === undefined ? {} : { budget: rosterBudget },
      ),
      discover,
      read,
      runtime: application.runtime,
    });
  const traced = read ? await application.runtime.serve(operation) : await operation();
  output.out(json ? asJson(traced) : render(traced, { payloads: !summary }));
  return traced.failures.length === 0 ? 0 : 1;
}

async function commandServe(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): Promise<number> {
  const { target, options } = transportArguments(argv, true);
  const loaded = await loadApplication({
    ...(environment.cwd === undefined ? {} : { start: environment.cwd }),
    ...(target === undefined ? {} : { target }),
  });
  const handle = await buildServer(loaded.application).start(options);
  if (handle !== undefined) output.error(`Serving MCP on ${handle.url}`);
  return 0;
}

async function commandDemo(argv: readonly string[], output: CliOutput): Promise<number> {
  const { options } = transportArguments(argv, false);
  const handle = await buildServer(demoApplication).start(options);
  if (handle !== undefined) output.error(`Serving bundled demo on ${handle.url}`);
  return 0;
}

async function compiled(target: string | undefined, environment: CliEnvironment) {
  const loaded = await loadApplication({
    ...(environment.cwd === undefined ? {} : { start: environment.cwd }),
    ...(target === undefined ? {} : { target }),
  });
  return compileRuntimeApplication(loaded.application);
}

function oneTarget(argv: readonly string[], command: string): string | undefined {
  if (argv.length > 1 || (argv[0]?.startsWith('-') ?? false))
    throw new UsageError(`Use contexture ${command} [TARGET].`);
  return argv[0];
}

async function inputObject(
  input: string | undefined,
  inputFile: string | undefined,
): Promise<Record<string, unknown>> {
  let raw = input;
  if (inputFile !== undefined) {
    try {
      raw = await readFile(inputFile, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new UsageError(`Cannot read ${inputFile}: ${message}`);
    }
  }
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new UsageError(`Tool input must be a JSON object: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new UsageError('Tool input must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function usage(): string {
  return 'Expected contexture new, list, check, call, inspect, serve, or demo.';
}

function transportArguments(
  argv: readonly string[],
  acceptsTarget: boolean,
): { readonly target: string | undefined; readonly options: ContextureOptions } {
  let target: string | undefined;
  let transport: 'stdio' | 'streamable-http' | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let endpointPath: string | undefined;
  const allowedHosts: string[] = [];
  const allowedOrigins: string[] = [];
  let allowAnonymous = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === undefined) throw new UsageError('Unexpected empty command argument.');
    if (!item.startsWith('--')) {
      if (!acceptsTarget || target !== undefined)
        throw new UsageError(
          acceptsTarget
            ? 'Use contexture serve [TARGET] [transport options].'
            : 'Use contexture demo [transport options].',
        );
      target = item;
      continue;
    }
    if (item === '--allow-anonymous') {
      if (allowAnonymous) throw new UsageError('Use --allow-anonymous at most once.');
      allowAnonymous = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`Option ${item} needs a value.`);
    switch (item) {
      case '--transport':
        if (transport !== undefined) throw new UsageError('Use --transport at most once.');
        if (value !== 'stdio' && value !== 'streamable-http')
          throw new UsageError('--transport must be stdio or streamable-http.');
        transport = value;
        break;
      case '--host':
        if (host !== undefined) throw new UsageError('Use --host at most once.');
        host = value;
        break;
      case '--port':
        if (port !== undefined) throw new UsageError('Use --port at most once.');
        port = Number(value);
        if (!Number.isInteger(port)) throw new UsageError('--port must be an integer.');
        break;
      case '--path':
        if (endpointPath !== undefined) throw new UsageError('Use --path at most once.');
        endpointPath = value;
        break;
      case '--allow-host':
        allowedHosts.push(value);
        break;
      case '--allow-origin':
        allowedOrigins.push(value);
        break;
      default:
        throw new UsageError(`Unknown transport option ${item}.`);
    }
    index += 1;
  }
  try {
    return Object.freeze({
      target,
      options: new ContextureOptions({
        ...(transport === undefined ? {} : { transport }),
        ...(host === undefined ? {} : { host }),
        ...(port === undefined ? {} : { port }),
        ...(endpointPath === undefined ? {} : { path: endpointPath }),
        ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
        ...(allowedOrigins.length === 0 ? {} : { allowedOrigins }),
        ...(allowAnonymous ? { allowAnonymous: true } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof ServeError) throw new UsageError(error.message);
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
