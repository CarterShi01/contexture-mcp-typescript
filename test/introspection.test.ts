import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { referenceApplication } from './support/reference-demo.js';
import {
  Contexture,
  NodePresentation,
  Presentation,
  PresentationCatalog,
  definePreProcess,
} from '../src/index.js';
import { SurfaceSelection } from '../src/core/index.js';
import { ModelValidationError } from '../src/core/foundation/errors.js';
import {
  compileRuntimeApplication,
  compileStructuralApplication,
} from '../src/server/application.js';
import { NodeCatalog, NodeCatalogSnapshot, canonicalDigest } from '../src/introspection.js';

function fixture() {
  let constructions = 0;
  let invocations = 0;
  const declared = {
    kind: 'role' as const,
    name: 'root',
    description: 'Operate.',
    instructions: 'Authored program.',
    preProcess: () =>
      definePreProcess({
        kind: 'role',
        name: 'before',
        description: 'Prepare.',
        instructions: 'Original process.',
      }),
    children: [
      () => ({
        kind: 'role' as const,
        name: 'branch',
        description: 'Branch.',
        instructions: 'Branch program.',
        skills: [
          () => ({
            kind: 'skill' as const,
            name: 'leaf',
            description: 'Leaf.',
            instructions: 'Leaf program.',
            uses: ['root/read'],
          }),
        ],
      }),
    ],
    skills: [
      () => ({
        kind: 'skill' as const,
        name: 'method',
        description: 'Stra\u00dfe method.',
        instructions: 'Internal needle.',
        uses: ['root/read'],
      }),
    ],
    tools: [
      () => ({
        kind: 'tool' as const,
        name: 'read',
        description: 'Read.',
        readOnly: true,
        input: z.strictObject({}),
        uses: ['root/method'],
        invoke: () => {
          invocations += 1;
          throw new Error('Catalog must not execute a business handler.');
        },
      }),
    ],
  };
  const declaration = Contexture({
    name: 'catalog-fixture',
    roots: [
      () => {
        constructions += 1;
        return declared;
      },
    ],
    promptRoots: [
      () => ({
        kind: 'skill' as const,
        name: 'private',
        description: 'Person only.',
        instructions: 'Ask a person.',
      }),
    ],
    prompts: [{ opens: 'private', description: 'Private command.', modelMayOpen: false }],
    presentation: new PresentationCatalog({
      defaultLocale: 'en',
      locales: {
        en: new Presentation(),
        fr: new Presentation({
          nodes: {
            root: new NodePresentation({ title: 'Racine', description: 'Agir.' }),
            'root/before': new NodePresentation({ title: 'Avant' }),
          },
        }),
      },
    }),
  });
  return { declaration, declared, observed: () => ({ constructions, invocations }) };
}

test('native reference declaration produces the separate normative Node Catalog golden and schema', () => {
  const compiled = compileRuntimeApplication(referenceApplication('contexture-demo'));
  const catalog = compiled.catalog({ view: 'model', detail: 'definition' });
  const actual = catalog.snapshot().asJson();
  const expected: unknown = JSON.parse(
    readFileSync('test/fixtures/node-catalog/golden.json', 'utf8'),
  );
  assert.deepEqual(actual, expected);
  const schema: unknown = JSON.parse(
    readFileSync('test/fixtures/node-catalog/schema.json', 'utf8'),
  );
  assert.ok(schema !== null && typeof schema === 'object');
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(actual), true, JSON.stringify(validate.errors));
  assert.equal(
    NodeCatalogSnapshot.fromJson(actual).contentDigest,
    catalog.snapshot().contentDigest,
  );
});

test('model/application/surface planes have exact projected roots, ordinals and reciprocal edges', () => {
  const source = fixture();
  const compiled = compileRuntimeApplication(source.declaration);
  const model = compiled.catalog({ view: 'model', detail: 'definition' });
  const all = compiled.catalog({ view: 'application', detail: 'definition' });
  assert.deepEqual(model.roots, ['root']);
  assert.deepEqual(all.roots, ['root', 'private']);
  assert.equal(all.get('private').plane, 'prompt');
  assert.equal(all.get('private').skill?.authored_instructions, 'Ask a person.');
  assert.throws(() => model.get('private'), ModelValidationError);
  const projected = compiled.catalog({
    view: 'surface',
    detail: 'definition',
    surfaceSelection: SurfaceSelection.only('root/branch'),
  });
  assert.deepEqual(projected.roots, ['root/branch']);
  assert.equal(projected.get('root/branch').parent_ref, null);
  assert.equal(projected.get('root/branch').ordinal, 0);
  assert.deepEqual(projected.get('root/branch/leaf').uses, []);
  assert.deepEqual(projected.get('root/branch/leaf').dependents, []);
  assert.equal(projected.get('root/branch/leaf').parent_ref, 'root/branch');
  assert.deepEqual(
    projected.children('root/branch').map((node) => node.ref),
    ['root/branch/leaf'],
  );
  assert.deepEqual(source.observed(), { constructions: 1, invocations: 0 });
});

test('all locales preserve authored description and programs while carrying selected presentation', () => {
  const source = fixture();
  const compiled = compileRuntimeApplication(source.declaration);
  const catalog = compiled.catalog({ view: 'application', detail: 'definition', locale: 'fr-CA' });
  const root = catalog.get('root');
  assert.equal(catalog.snapshot().application.locale, 'fr');
  assert.equal(root.description, 'Operate.');
  assert.deepEqual(root.presentation, { title: 'Racine', description: 'Agir.' });
  assert.equal(root.role?.authored_instructions, 'Authored program.');
  assert.match(root.role!.effective_instructions, /Authored program\./);
  assert.equal(root.role?.pre_process_ref, 'root/before');
  assert.equal(root.members[0]?.slot, 'pre_process');
  assert.equal(catalog.get('root/before').presentation?.title, 'Avant');
  assert.equal(catalog.get('root/read').tool?.execution_available, true);
  assert.deepEqual(source.observed(), { constructions: 1, invocations: 0 });
});

test('structural Catalog cannot assert execution and summary never emits programs or schemas', () => {
  const source = fixture();
  const compiled = compileStructuralApplication(source.declaration);
  const full = compiled.catalog({ view: 'application', detail: 'definition' });
  assert.equal(full.snapshot().application.mode, 'disclosure-only');
  assert.equal(full.snapshot().application.execution_bound, false);
  assert.deepEqual(full.get('root/read').tool, { execution_available: false });
  const summary = compiled.catalog({ view: 'model' });
  for (const node of summary.snapshot().nodes) {
    assert.equal(node.role, null);
    assert.equal(node.skill, null);
    assert.equal(node.tool, null);
  }
  assert.deepEqual(source.observed(), { constructions: 1, invocations: 0 });
});

test('Catalog snapshots detach contributor data, preserve exact integers and invoke only visible contributors once', () => {
  const source = fixture();
  const compiled = compileRuntimeApplication(source.declaration);
  const observed: string[] = [];
  const metadata = { facts: [{ owner: 'application' }], exact: 90071992547409931234567890n };
  const catalog = compiled.catalog({
    view: 'surface',
    surfaceSelection: SurfaceSelection.only('root/branch'),
    contributors: [
      {
        namespace: 'host/source',
        describe(ref, _node, graph) {
          assert.equal(graph, compiled.index);
          observed.push(ref);
          return metadata;
        },
      },
    ],
  });
  metadata.facts[0]!.owner = 'changed';
  source.declared.instructions = 'Changed author source.';
  assert.deepEqual(observed, ['root/branch', 'root/branch/leaf']);
  assert.match(catalog.snapshot().toJson(null), /90071992547409931234567890/);
  assert.match(catalog.snapshot().toJson(null), /"owner":"application"/);
  assert.equal(
    catalog.snapshot().contentDigest,
    canonicalDigest(
      Object.fromEntries(
        Object.entries(catalog.snapshot().asJson()).filter(([key]) => key !== 'content_digest'),
      ),
    ),
  );
  assert.ok(Object.isFrozen(catalog.get('root/branch')));
  assert.ok(Object.isFrozen(catalog.get('root/branch').extensions));
  assert.deepEqual(source.observed(), { constructions: 1, invocations: 0 });
});

test('Catalog search uses full folding across native text, programs, Tool schema and extensions', () => {
  const compiled = compileRuntimeApplication(fixture().declaration);
  const catalog = compiled.catalog({
    view: 'model',
    detail: 'definition',
    contributors: [
      {
        namespace: 'host/source',
        describe(ref) {
          return ref === 'root' ? { review: 'Specific evidence' } : null;
        },
      },
    ],
  });
  assert.deepEqual(
    catalog.list({ query: 'STRASSE' }).map((node) => node.ref),
    ['root/method'],
  );
  assert.deepEqual(
    catalog.list({ query: 'internal needle' }).map((node) => node.ref),
    ['root/method'],
  );
  assert.deepEqual(
    catalog.list({ query: '"type": "object"', kind: 'tool' }).map((node) => node.ref),
    ['root/read'],
  );
  assert.deepEqual(
    catalog.list({ query: 'specific evidence' }).map((node) => node.ref),
    ['root'],
  );
  assert.equal(catalog.list({ query: '\u0085\u0085' }).length, catalog.snapshot().nodes.length);
  assert.equal(catalog.list({ kind: 'tool' }).length, 1);
});

test('invalid view/selection/contributors and corrupt cross-node snapshots fail explicitly', () => {
  const index = compileRuntimeApplication(fixture().declaration).index;
  assert.throws(() => NodeCatalog.of(index, { view: 'surface' }), ModelValidationError);
  assert.throws(
    () => NodeCatalog.of(index, { view: 'model', surfaceSelection: SurfaceSelection.all() }),
    ModelValidationError,
  );
  assert.throws(
    () =>
      NodeCatalog.of(index, {
        view: 'model',
        contributors: [
          {
            namespace: 'no-owner',
            describe() {
              return {};
            },
          },
        ],
      }),
    ModelValidationError,
  );
  assert.throws(
    () =>
      NodeCatalog.of(index, {
        view: 'model',
        contributors: [
          {
            namespace: 'host/source',
            describe() {
              return {};
            },
          },
          {
            namespace: 'host/source',
            describe() {
              return {};
            },
          },
        ],
      }),
    ModelValidationError,
  );
  assert.throws(
    () =>
      NodeCatalog.of(index, {
        view: 'model',
        contributors: [
          {
            namespace: 'host/source',
            describe() {
              return new Date();
            },
          },
        ],
      }),
    ModelValidationError,
  );
  const value = NodeCatalog.of(index, { view: 'model', detail: 'definition' }).snapshot().asJson();
  const base: Record<string, unknown> = JSON.parse(JSON.stringify(value));
  assert.throws(
    () => NodeCatalogSnapshot.fromJson({ ...base, content_digest: 'sha256:' + '0'.repeat(64) }),
    ModelValidationError,
  );
  assert.throws(
    () => NodeCatalogSnapshot.of({ ...base, content_digest: undefined }),
    ModelValidationError,
  );
  const body = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'content_digest'));
  assert.throws(() => NodeCatalogSnapshot.of({ ...body, roots: [] }), ModelValidationError);
  assert.throws(
    () => NodeCatalogSnapshot.of({ ...body, counts: { role: 999, skill: 0, tool: 0 } }),
    ModelValidationError,
  );
  let executions = 0;
  assert.throws(
    () =>
      NodeCatalogSnapshot.of(
        Object.defineProperty({}, 'schema', {
          enumerable: true,
          get() {
            executions += 1;
            return 'contexture.node-catalog/v1';
          },
        }),
      ),
    ModelValidationError,
  );
  assert.equal(executions, 0);
});
