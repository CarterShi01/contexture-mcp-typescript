import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { main } from '../src/cli/index.js';

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    writer: { out: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
  };
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'contexture-catalog-cli-'));
  const api = pathToFileURL(path.resolve('src/index.ts')).href;
  const schema = pathToFileURL(path.resolve('node_modules/zod/index.js')).href;
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', contexture: { app: './app.js' } }),
  );
  await writeFile(
    path.join(root, 'app.js'),
    `
import { Presentation, PresentationCatalog, NodePresentation } from ${JSON.stringify(api)};
import { z } from ${JSON.stringify(schema)};
export let invocations = 0;
export const app = {
  name: 'catalog-cli', roots: [() => ({
    kind: 'role', name: 'root', description: 'Root.', instructions: 'Source program.',
    skills: [() => ({ kind: 'skill', name: 'leaf', description: 'Leaf.', instructions: 'Leaf program.' })],
    tools: [() => ({
      kind: 'tool', name: 'read', description: 'Read.', readOnly: true, input: z.strictObject({}),
      invoke() { invocations += 1; throw new Error('Catalog must not execute business handlers'); },
    })],
  })],
  promptRoots: [() => ({ kind: 'skill', name: 'private', description: 'Person only.', instructions: 'Ask.' })],
  presentation: new PresentationCatalog({ defaultLocale: 'en', locales: {
    en: new Presentation(),
    fr: new Presentation({ nodes: { root: new NodePresentation({ title: 'Racine' }) } }),
  } }),
};`,
  );
  return root;
}

test('native catalog CLI emits complete snapshot, exact ref array and explicit locale without invoking', async () => {
  const root = await project();
  try {
    const whole = output();
    assert.equal(
      await main(
        ['catalog', '--json', '--detail', 'definition', '--locale', 'fr-CA'],
        whole.writer,
        { cwd: root },
      ),
      0,
    );
    const snapshot = JSON.parse(whole.lines[0]!);
    assert.equal(snapshot.schema, 'contexture.node-catalog/v1');
    assert.equal(snapshot.application.locale, 'fr');
    assert.equal(snapshot.nodes[0].presentation.title, 'Racine');
    assert.deepEqual(snapshot.counts, { role: 1, skill: 1, tool: 1 });
    const selected = output();
    assert.equal(await main(['catalog', 'root/leaf', '--json'], selected.writer, { cwd: root }), 0);
    const nodes = JSON.parse(selected.lines[0]!);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].ref, 'root/leaf');
    assert.equal(nodes[0].skill, null);
    const module = await import(pathToFileURL(path.join(root, 'app.js')).href);
    assert.equal(module.invocations, 0);
    assert.deepEqual(whole.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog CLI projects selected descendant roots and human summary preserves canonical refs', async () => {
  const root = await project();
  try {
    const selected = output();
    assert.equal(
      await main(
        ['catalog', '--view', 'surface', '--select', 'root/leaf', '--json'],
        selected.writer,
        { cwd: root },
      ),
      0,
    );
    const snapshot = JSON.parse(selected.lines[0]!);
    assert.deepEqual(snapshot.roots, ['root/leaf']);
    assert.equal(snapshot.nodes[0].parent_ref, null);
    assert.equal(snapshot.nodes[0].ordinal, 0);
    const human = output();
    assert.equal(await main(['catalog', '--view', 'application'], human.writer, { cwd: root }), 0);
    assert.equal(human.lines[0], 'catalog-cli  runtime  application/summary');
    assert.match(human.lines[1]!, /^digest {2}sha256:/);
    assert.ok(human.lines.some((line) => line.includes('private')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog CLI invalid arguments/ref scope fail explicitly with no output', async () => {
  const root = await project();
  try {
    for (const args of [
      ['--view', 'unknown'],
      ['--detail', 'unknown'],
      ['--select', 'root'],
      ['--view', 'surface'],
      ['--locale'],
      ['--unknown'],
    ]) {
      const result = output();
      assert.equal(await main(['catalog', ...args], result.writer, { cwd: root }), 2);
      assert.deepEqual(result.lines, []);
      assert.match(result.errors[0]!, /^contexture: /);
    }
    const hidden = output();
    assert.equal(await main(['catalog', 'private', '--json'], hidden.writer, { cwd: root }), 1);
    assert.deepEqual(hidden.lines, []);
    assert.match(hidden.errors[0]!, /not present/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('debug CLI starts a real read-only listener and explicit caller cancellation closes it', async () => {
  const root = await project();
  const controller = new AbortController();
  const result = output();
  let ready: ((url: string) => void) | undefined;
  const started = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const running = main(
    ['debug', '--port', '0'],
    {
      out: (line) => {
        result.writer.out(line);
        if (line.startsWith('Contexture Node Catalog: '))
          ready?.(line.slice('Contexture Node Catalog: '.length));
      },
      error: result.writer.error,
    },
    { cwd: root, signal: controller.signal },
  );
  try {
    const url = await Promise.race([
      started,
      running.then((status) => {
        throw new Error(`Debug stopped before ready: ${status}`);
      }),
    ]);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const catalog = await (await fetch(`${url}/api/catalog`)).json();
    assert.equal(catalog.application.view, 'application');
    assert.equal(catalog.application.detail, 'definition');
    controller.abort();
    assert.equal(await running, 0);
    await assert.rejects(fetch(`${url}/healthz`));
    assert.deepEqual(result.errors, []);
  } finally {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});
