import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  Contexture,
  definePreProcess,
  GatewayPresentation,
  NodePresentation,
  Presentation,
  PresentationCatalog,
  GATEWAY_TOOL_NAMES,
  normalizeLocale,
  resolvePresentation,
} from '../src/index.js';
import { compileApplication, Disclosure, RootSelection } from '../src/core/index.js';
import {
  buildServer,
  compileRuntimeApplication,
  compileStructuralApplication,
} from '../src/server/index.js';

function application(presentation?: Presentation | PresentationCatalog) {
  return Contexture({
    name: 'stable-machine-name',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'ops',
        description: 'Operate.',
        instructions: 'Original program.',
        skills: [
          () => ({
            kind: 'skill' as const,
            name: 'method',
            description: 'Method.',
            instructions: 'Do not translate.',
            uses: ['ops/read'],
          }),
        ],
        tools: [
          () => ({
            kind: 'tool' as const,
            name: 'read',
            description: 'Read.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => 'ok',
          }),
        ],
      }),
    ],
    promptRoots: [
      () => ({
        kind: 'skill' as const,
        name: 'private',
        description: 'Person only.',
        instructions: 'Ask a person.',
      }),
    ],
    prompts: [{ opens: 'private', description: 'Person command.', modelMayOpen: false }],
    ...(presentation === undefined ? {} : { presentation }),
  });
}

function localized() {
  return new PresentationCatalog({
    defaultLocale: 'en',
    locales: {
      en: new Presentation({
        title: 'Human title',
        gateway: new GatewayPresentation(),
        nodes: { ops: new NodePresentation({ title: 'Operations' }) },
      }),
      fr: new Presentation({
        title: 'Titre',
        description: 'Description localisee',
        gateway: new GatewayPresentation({ discover: 'Explorer' }),
        nodes: {
          ops: new NodePresentation({ title: 'Operations FR', description: 'Agir.' }),
          'ops/read': new NodePresentation({ title: 'Lire', description: 'Lecture.' }),
          private: new NodePresentation({ title: 'Commande' }),
        },
      }),
    },
  });
}

test('presentation is immutable, detached, normalized and lazy', () => {
  const nodes = {
    ops: new NodePresentation({ title: '  Operations  ', description: '  Operate.  ' }),
  };
  const presentation = new Presentation({ title: ' Title ', nodes });
  let constructions = 0;
  Contexture({
    name: 'lazy',
    presentation,
    roots: [
      () => {
        constructions += 1;
        return { kind: 'skill', name: 'ops', description: 'Ops.', instructions: 'Wait.' };
      },
    ],
  });
  nodes.ops = new NodePresentation({ title: 'Changed' });
  assert.equal(presentation.nodes.ops?.title, 'Operations');
  assert.equal(presentation.nodes.ops?.description, 'Operate.');
  assert.equal(presentation.title, 'Title');
  assert.equal(constructions, 0);
  assert.ok(Object.isFrozen(presentation));
  assert.ok(Object.isFrozen(presentation.nodes));
  assert.ok(Object.isFrozen(presentation.nodes.ops));
});

for (const [source, expected] of [
  [' zh_hans_cn ', 'zh-Hans-CN'],
  ['EN-us', 'en-US'],
  ['es-419', 'es-419'],
  ['de-DE-u-co-phonebk', 'de-DE-u-CO-phonebk'],
]) {
  test(`presentation locale normalizes ${source}`, () =>
    assert.equal(normalizeLocale(source!), expected));
}

test('catalog resolves exact, parent and default without a preferred language', () => {
  const french = new Presentation({ title: 'French' });
  const source = new PresentationCatalog({
    defaultLocale: 'fr',
    locales: {
      fr: french,
      'zh-Hans': new Presentation({ title: 'Simplified' }),
      'zh-Hans-CN': new Presentation({ title: 'Mainland' }),
    },
  });

  assert.equal(source.resolve('zh-Hans-CN')[1].title, 'Mainland');
  assert.deepEqual(source.resolve('zh-Hans-SG')[0], 'zh-Hans');
  assert.deepEqual(source.resolve('un-KNOWN'), ['fr', french]);
  assert.deepEqual(source.resolve(), ['fr', french]);
  assert.deepEqual(resolvePresentation(french, 'FR_ca'), ['fr-CA', french]);
});

test('locale whitespace, titlecase expansions, uncased letters and final sigma match reference semantics', () => {
  assert.equal(normalizeLocale('\u0085en\u0085'), 'en');
  assert.throws(() => normalizeLocale('\ufeffen'));
  for (const [source, expected] of [
    ['en-\u00dfabc', 'en-Ssabc'],
    ['en-\u01c6abc', 'en-\u01c5abc'],
    ['en-\u1f80abc', 'en-\u1f88abc'],
    ['en-\u0130abc', 'en-\u0130abc'],
    ['en-\u4e2dabc', 'en-\u4e2dAbc'],
    ['en-ab\u03a3\u03a3', 'en-Ab\u03c3\u03c2'],
    ['en-\u019babc', 'en-\u019babc'],
    ['en-\u0264abc', 'en-\u0264abc'],
    ['en-\u0295abc', 'en-\u0295abc'],
    ['en-a\u0295bc', 'en-A\u0295bc'],
    ['en-\ua7d3abc', 'en-\ua7d3abc'],
    ['en-\ua7d5abc', 'en-\ua7d5abc'],
  ])
    assert.equal(normalizeLocale(source!), expected);
});

test('erased constructor inputs and duplicate normalized locale/ref keys fail explicitly', () => {
  for (const value of ['', ' ', null, 3, false]) {
    assert.throws(() => Reflect.construct(NodePresentation, [{ title: value }]));
    assert.throws(() => Reflect.construct(GatewayPresentation, [{ discover: value }]));
    assert.throws(() => Reflect.construct(Presentation, [{ title: value }]));
  }
  for (const value of ['e', 'en--US', 'en-123456789', '-en', 'en/US', null, false]) {
    assert.throws(() => Reflect.apply(normalizeLocale, undefined, [value]));
  }
  assert.throws(() => new PresentationCatalog({ defaultLocale: 'en', locales: {} }));
  assert.throws(
    () =>
      new PresentationCatalog({
        defaultLocale: 'en',
        locales: {
          en: new Presentation(),
          EN: new Presentation(),
        },
      }),
  );
  assert.throws(
    () =>
      new Presentation({
        nodes: {
          ops: new NodePresentation({ title: 'One' }),
          ' ops ': new NodePresentation({ title: 'Two' }),
        },
      }),
  );
  assert.throws(() => Reflect.construct(Presentation, [{ gateway: {} }]));
  assert.throws(() => Reflect.construct(Presentation, [{ nodes: { ops: { title: 'Fake' } } }]));
  assert.throws(() => Reflect.apply(resolvePresentation, undefined, [{}, 'en']));
  assert.throws(() => Reflect.construct(GatewayPresentation, [{ invoke_read_only: 'Wrong ABI' }]));
  assert.throws(() => Reflect.construct(NodePresentation, [{ title: 'Title', extra: 'Unknown' }]));
  assert.throws(() => Reflect.construct(Presentation, [{ extra: 'Unknown' }]));
  assert.throws(() =>
    Reflect.construct(PresentationCatalog, [
      {
        defaultLocale: 'en',
        locales: { en: new Presentation() },
        extra: 'Unknown',
      },
    ]),
  );
});

test('all declared locale node refs are validated, including a nonselected locale', () => {
  const source = new PresentationCatalog({
    defaultLocale: 'en',
    locales: {
      en: new Presentation(),
      fr: new Presentation({ nodes: { missing: new NodePresentation({ title: 'Missing' }) } }),
    },
  });
  assert.throws(() => compileApplication(application(source)), /unknown node ref/);
});

test('localized route, inspect, active and uses cards retain native identity and execution', async () => {
  const declaration = application(localized());
  const compiled = compileRuntimeApplication(declaration, { locale: 'fr-CA' });
  assert.equal(compiled.locale, 'fr');
  const root = compiled.disclosure.discover().roles[0]!;
  assert.equal(root.name, 'ops');
  assert.equal(root.ref, 'ops');
  assert.equal(root.title, 'Operations FR');
  assert.equal(root.description, 'Agir.');
  const active = compiled.disclosure.open('ops');
  assert.equal(active.instructions, 'Original program.');
  assert.equal(active.title, 'Operations FR');
  const tools = active.tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools[0].name, 'read');
  assert.equal(tools[0].title, 'Lire');
  const inspected = compiled.disclosure.inspect(['ops/read']).items[0]!;
  assert.deepEqual(inspected.node, {
    kind: 'tool',
    name: 'read',
    title: 'Lire',
    description: 'Lecture.',
    ref: 'ops/read',
  });
  const method = compiled.disclosure.open('ops/method');
  assert.equal(method.instructions, 'Do not translate.');
  assert.ok(Array.isArray(method.uses));
  assert.equal(method.uses[0].title, 'Lire');
  assert.equal(await compiled.runtime.invokeReadOnly('ops/read'), 'ok');
  const baseline = compileRuntimeApplication(application());
  assert.deepEqual(
    compiled.index.schemaOf(compiled.index.tool('ops/read')),
    baseline.index.schemaOf(baseline.index.tool('ops/read')),
  );
});

test('localized process cards retain canonical designation and business instructions', () => {
  const compiled = compileRuntimeApplication(
    Contexture({
      name: 'process-copy',
      presentation: new Presentation({
        nodes: {
          'ops/before': new NodePresentation({ title: 'Before label' }),
        },
      }),
      roots: [
        () => ({
          kind: 'role',
          name: 'ops',
          description: 'Operate.',
          instructions: 'Business program.',
          preProcess: () =>
            definePreProcess({
              kind: 'role',
              name: 'before',
              description: 'Prepare.',
              instructions: 'Original process.',
            }),
        }),
      ],
    }),
  );
  const opened = compiled.disclosure.open('ops');
  assert.equal(opened.pre_process, 'ops/before');
  assert.equal(typeof opened.instructions, 'string');
  assert.match(String(opened.instructions), /Business program\./);
  assert.ok(Array.isArray(opened.roles));
  assert.equal(opened.roles[0].name, 'before');
  assert.equal(opened.roles[0].title, 'Before label');
  assert.equal(compiled.index.find('ops/before').name, 'before');
});

test('selection, person publication and independent locale views preserve reservations and copy', async () => {
  const compiled = compileRuntimeApplication(application(localized()), { locale: 'fr' });
  const selected = compiled.disclosure.select(RootSelection.all());
  assert.equal(selected.discover().roles[0]!.title, 'Operations FR');
  assert.throws(() => selected.open('private'), /opened by a person/);
  assert.equal(selected.unrestricted().openForPerson('private').title, 'Commande');
  const english = new Disclosure(compiled.index, { locale: 'en' });
  assert.equal(english.discover().roles[0]!.title, 'Operations');
  assert.equal(compiled.disclosure.discover().roles[0]!.title, 'Operations FR');
});

test('legacy defaults and prototype-like refs do not acquire phantom titles', () => {
  const compiled = compileRuntimeApplication(application());
  assert.deepEqual(compiled.disclosure.discover().roles[0], {
    kind: 'role',
    name: 'ops',
    description: 'Operate.',
    ref: 'ops',
  });
  const index = compileApplication(
    Contexture({
      name: 'prototype-refs',
      roots: [
        () => ({
          kind: 'skill',
          name: 'toString',
          description: 'Known node.',
          instructions: 'Keep.',
        }),
      ],
    }),
  );
  assert.equal(new Disclosure(index).discover().skills[0]!.title, undefined);
});

test('real official SDK initialization and gateway titles retain fixed names, schemas and safety', async () => {
  const configured = buildServer(application(localized()), { locale: 'fr' });
  const { identity, tools, instructions } = await surface(configured.build().server);
  assert.equal(identity.name, 'stable-machine-name');
  assert.equal(identity.title, 'Titre');
  assert.equal(identity.description, 'Description localisee');
  assert.ok(instructions);
  assert.match(instructions, /- Operations FR \(ops\): Agir\./);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...GATEWAY_TOOL_NAMES],
  );
  assert.equal(tools.find((tool) => tool.name === 'contexture_discover')?.title, 'Explorer');
  assert.equal(
    tools.find((tool) => tool.name === 'contexture_invoke')?.annotations?.readOnlyHint,
    false,
  );
  assert.equal(
    tools.find((tool) => tool.name === 'contexture_invoke_read_only')?.annotations?.readOnlyHint,
    true,
  );
  const baseline = await surface(buildServer(application()).build().server);
  const withoutTitle = (values: typeof tools) =>
    values.map((value) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'title')),
    );
  assert.deepEqual(withoutTitle(tools), withoutTitle(baseline.tools));
  const structural = compileStructuralApplication(application(localized()), { locale: 'fr' });
  assert.equal(structural.index.isBound, false);
  assert.equal(structural.disclosure.discover().roles[0]!.title, 'Operations FR');
});

async function surface(server: McpServer) {
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await client.start();
  await server.connect(host);
  try {
    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'presentation-consumer', version: '1' },
      },
    });
    const initialized = z
      .object({
        result: z.object({
          serverInfo: z.object({
            name: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
          }),
          instructions: z.string().optional(),
        }),
      })
      .parse(await reply(1));
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              title: z.string().optional(),
              description: z.string().optional(),
              inputSchema: z.record(z.string(), z.unknown()),
              annotations: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      })
      .parse(await reply(2));
    return {
      identity: initialized.result.serverInfo,
      tools: listed.result.tools,
      instructions: initialized.result.instructions,
    };
  } finally {
    await client.close();
    await server.close();
  }

  async function reply(id: number): Promise<unknown> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (replies.has(id)) return replies.get(id);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Timed out waiting for official SDK response.');
  }
}
