#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { newProject } from './scaffold.js';
import { UsageError } from './usage.js';

export const CLI_VERSION = '0.12.0rc1';

export interface CliOutput {
  readonly out: (line: string) => void;
  readonly error: (line: string) => void;
}

const processOutput: CliOutput = {
  out: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

/** Execute the implemented Contexture command-line workflows. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  output: CliOutput = processOutput,
): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === '--version') {
      output.out(CLI_VERSION);
      return 0;
    }
    if (argv[0] !== 'new') {
      throw new UsageError(
        'Expected `contexture new NAME [--into DIR]`, or `contexture --version`. Other product commands are not installed in this build.',
      );
    }
    const [name, ...rest] = argv.slice(1);
    if (name === undefined || name.startsWith('-'))
      throw new UsageError('`contexture new` needs a project name.');
    let destination: string | undefined;
    while (rest.length > 0) {
      const option = rest.shift();
      if (option !== '--into' || destination !== undefined || rest.length === 0)
        throw new UsageError('Use `contexture new NAME [--into DIR]`.');
      destination = rest.shift();
    }
    const root = await newProject(name, destination === undefined ? {} : { destination });
    output.out(`Wrote ${root}`);
    output.out('Next: npm install && npm run check');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contexture command failed.';
    output.error(`contexture: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
