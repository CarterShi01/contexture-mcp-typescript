import assert from 'node:assert/strict';
import test from 'node:test';
import { Contexture } from '../src/index.js';
import { compileApplication, SurfaceSelection } from '../src/core/index.js';
import { NodeCatalog } from '../src/introspection.js';

test('Catalog projection enumerates one cut and uses linear index queries with many anchors/prompt roots', () => {
  const size = 1200;
  const roots = Array.from({ length: size }, (_, index) => () => ({
    kind: 'skill' as const,
    name: `node-${index}`,
    description: 'Node.',
    instructions: 'Program.',
    uses: index === 0 ? [] : ['node-0'],
  }));
  const promptRoots = Array.from({ length: size }, (_, index) => () => ({
    kind: 'skill' as const,
    name: `private-${index}`,
    description: 'Private.',
    instructions: 'Person.',
  }));
  const index = compileApplication(Contexture({ name: 'projection-bounds', roots, promptRoots }));
  let walks = 0;
  let lookups = 0;
  const counted = new Proxy(index, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === 'walk')
        return () => {
          walks += 1;
          return target.walk();
        };
      if (['find', 'refOf', 'parentOf', 'dependentsOf'].includes(String(key))) {
        return (...args: unknown[]) => {
          lookups += 1;
          if (typeof value !== 'function') throw new Error('Expected an Index method.');
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const selected = SurfaceSelection.only(roots.map((factory) => factory().name));
  const catalog = NodeCatalog.of(counted, { view: 'surface', surfaceSelection: selected });
  assert.equal(catalog.snapshot().nodes.length, size);
  assert.equal(catalog.get('node-0').dependents.length, size - 1);
  assert.equal(walks, 2);
  assert.ok(lookups <= size * 12, `index lookup budget exceeded: ${lookups}`);
  assert.ok(catalog.snapshot().nodes.every((node) => node.plane === 'model'));
});

test('selected-root antichain removes ancestors without pairwise startsWith scans', () => {
  const size = 1600;
  const index = compileApplication(
    Contexture({
      name: 'selection-bounds',
      roots: Array.from({ length: size }, (_, ordinal) => () => ({
        kind: 'role' as const,
        name: `root-${ordinal}`,
        description: 'Root.',
        instructions: 'Root.',
        children: [
          () => ({
            kind: 'role' as const,
            name: 'child',
            description: 'Child.',
            instructions: 'Child.',
          }),
        ],
      })),
    }),
  );
  const selected = SurfaceSelection.only(
    index.roots.flatMap((node) => {
      const root = index.refOf(node);
      return [root, `${root}/child`];
    }),
  );
  const original = String.prototype.startsWith;
  let checks = 0;
  String.prototype.startsWith = function (search: string, position?: number): boolean {
    checks += 1;
    return original.call(this, search, position);
  };
  try {
    const result = selected.resolve(index);
    assert.equal(result.names?.length, size);
    assert.ok(result.names?.every((name) => !name.includes('/')));
    assert.ok(checks <= size * 4, `pairwise ancestor scans observed: ${checks}`);
  } finally {
    String.prototype.startsWith = original;
  }
});
