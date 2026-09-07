import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DISCOVER_GATEWAY_NAME,
  GATEWAY_TOOL_NAMES,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REFERENCE_SEPARATOR,
  RootSelection,
  defineApplication,
} from '../src/index.js';
import { compileApplication, GATEWAY } from '../src/core/index.js';
import type { Prompt } from '../src/core/mcp-interface/prompt.js';
import type { Resource } from '../src/core/mcp-interface/resource.js';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(target) : [target];
      }),
    )
  )
    .flat()
    .filter((file) => file.endsWith('.ts'));
}

test('foundation owns one public spelling for package, reference, and gateway vocabulary', () => {
  assert.equal(PACKAGE_NAME, 'contexture');
  assert.equal(PACKAGE_VERSION, '0.12.0rc1');
  assert.equal(REFERENCE_SEPARATOR, '/');
  assert.deepEqual(GATEWAY_TOOL_NAMES, [
    DISCOVER_GATEWAY_NAME,
    OPEN_GATEWAY_NAME,
    INVOKE_READ_ONLY_GATEWAY_NAME,
    INVOKE_GATEWAY_NAME,
  ]);
  assert.deepEqual(
    GATEWAY.map((tool) => tool.name),
    GATEWAY_TOOL_NAMES,
  );
  assert.throws(() => {
    (GATEWAY_TOOL_NAMES as string[]).push('business_tool');
  }, TypeError);
});

test('foundation publications retain MCP-interface compatibility without a second shape', () => {
  const prompt = {
    opens: 'operations',
    description: 'Open operations.',
    modelMayOpen: false,
  } satisfies Prompt;
  const resource = {
    opens: 'operations/status',
    uri: 'contexture://operations/status',
    description: 'Read status.',
  } satisfies Resource;
  const application = defineApplication({
    name: 'foundation-publications',
    roots: [
      () => ({ kind: 'skill', name: 'operations', description: 'Operate.', instructions: 'Read.' }),
    ],
    prompts: [prompt],
    resources: [resource],
  });
  assert.equal(application.prompts?.[0]?.modelMayOpen, false);
  assert.equal(application.resources?.[0]?.uri, 'contexture://operations/status');
});

test('core reference parsing consumes the foundation separator, not a local spelling', () => {
  const ref = ['operations', 'status'].join(REFERENCE_SEPARATOR);
  const index = compileApplication(
    defineApplication({
      name: 'foundation-references',
      roots: [
        () => ({
          kind: 'role',
          name: 'operations',
          description: 'Operate.',
          instructions: 'Read.',
          skills: [
            () => ({
              kind: 'skill',
              name: 'status',
              description: 'Status.',
              instructions: 'Inspect.',
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(index.find(`${REFERENCE_SEPARATOR}${ref}${REFERENCE_SEPARATOR}`).name, 'status');
  assert.throws(() => RootSelection.only(ref), /root refs only/);
});

test('model code does not import the sibling MCP primitive projection', async () => {
  for (const file of await sourceFiles(path.resolve('src/core/model'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"].*mcp-interface\//, file);
  }
});
