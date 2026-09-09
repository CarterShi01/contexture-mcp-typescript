import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLI_VERSION, main, UsageError } from '../src/cli/index.js';
import { ContextureError, PACKAGE_VERSION, REFERENCE_SEPARATOR } from '../src/index.js';

function output() {
  const out: string[] = [];
  const error: string[] = [];
  return {
    out,
    error,
    writer: { out: (line: string) => out.push(line), error: (line: string) => error.push(line) },
  };
}

test('CLI reports its version and creates a project through the real scaffold', async () => {
  const version = output();
  assert.equal(await main(['--version'], version.writer), 0);
  assert.deepEqual(version.out, [CLI_VERSION]);
  assert.equal(CLI_VERSION, PACKAGE_VERSION);

  const temporary = await mkdtemp(path.join(tmpdir(), 'contexture-cli-'));
  try {
    const created = output();
    assert.equal(await main(['new', 'My Context', '--into', temporary], created.writer), 0);
    await stat(path.join(temporary, 'my-context', 'assistant', 'app.js'));
    assert.match(created.out[0] ?? '', /^Wrote /);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI sends usage errors to stderr with status two', async () => {
  assert.ok(new UsageError('bad usage') instanceof ContextureError);
  const invalid = output();
  assert.equal(await main(['new'], invalid.writer), 2);
  assert.match(invalid.error[0] ?? '', /^contexture: /);

  const invalidTransport = output();
  assert.equal(await main(['demo', '--host', '0.0.0.0'], invalidTransport.writer), 2);
  assert.match(invalidTransport.error[0] ?? '', /transport='stdio'/);
});

test('inspect uses the bundled demo when no project configuration exists', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'contexture-no-project-'));
  try {
    const inspected = output();
    assert.equal(await main(['inspect', '--json'], inspected.writer, { cwd: temporary }), 0);
    assert.equal(JSON.parse(inspected.out[0] ?? '{}').steps.length, 2);
    assert.match(inspected.error[0] ?? '', /bundled demo/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI compiles, lists, inspects, and invokes a native project declaration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'contexture-cli-project-'));
  try {
    await mkdir(path.join(root, 'assistant'), { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'module', contexture: { app: './assistant/app.js' } }),
    );
    const zod = new URL('../node_modules/zod/index.js', import.meta.url).href;
    await writeFile(
      path.join(root, 'assistant', 'app.js'),
      `import { z } from ${JSON.stringify(zod)};
export const app = {
  name: 'sample',
  roots: [() => ({
    kind: 'role', name: 'assistant', description: 'Answer sample requests.',
    instructions: 'Use the available tools.',
    skills: [() => ({
      kind: 'skill', name: 'read-first', description: 'Read before acting.',
      instructions: 'Call read, then report.', uses: ['assistant/read'],
    })],
    tools: [
      () => ({
        kind: 'tool', name: 'read', description: 'Read one value.', readOnly: true,
        input: z.strictObject({ value: z.string() }), invoke: ({ value }) => 'read:' + value,
      }),
      () => ({
        kind: 'tool', name: 'write', description: 'Write one value.', readOnly: false,
        input: z.strictObject({ value: z.string() }), invoke: ({ value }) => ({ wrote: value }),
      }),
    ],
  })],
};
`,
    );
    const environment = { cwd: root };

    const checked = output();
    assert.equal(await main(['check'], checked.writer, environment), 0);
    assert.deepEqual(checked.out, ['OK sample: 1 role(s), 1 skill(s), 2 tool(s)']);

    const listed = output();
    assert.equal(await main(['list'], listed.writer, environment), 0);
    assert.match(listed.out.join('\n'), /skill {5}assistant\/read-first/);
    assert.match(listed.out.join('\n'), /tool {6}assistant\/write {2}\(needs approval\)/);

    const inspected = output();
    assert.equal(await main(['inspect', '--all', '--json'], inspected.writer, environment), 0);
    assert.equal(JSON.parse(inspected.out[0] ?? '{}').steps.length, 6);

    const called = output();
    assert.equal(
      await main(
        ['call', ['assistant', 'read'].join(REFERENCE_SEPARATOR), '--input', '{"value":"ok"}'],
        called.writer,
        environment,
      ),
      0,
    );
    assert.deepEqual(called.out, ['read:ok']);

    const refused = output();
    assert.equal(
      await main(
        ['call', 'assistant/write', '--input', '{"value":"no"}'],
        refused.writer,
        environment,
      ),
      2,
    );
    assert.match(refused.error[0] ?? '', /--allow-write/);

    const written = output();
    assert.equal(
      await main(
        ['call', 'assistant/write', '--input', '{"value":"yes"}', '--allow-write'],
        written.writer,
        environment,
      ),
      0,
    );
    assert.deepEqual(written.out, ['{"wrote":"yes"}']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
