import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { app } from '../src/demo/server.js';
import { compileRuntimeApplication } from '../src/server/index.js';

const goldenDirectory = path.resolve('conformance/golden');

test('the shipped demo is a native declaration with the normative disclosure and documents', async () => {
  const application = compileRuntimeApplication(app);
  const expected = JSON.parse(
    await readFile(path.join(goldenDirectory, 'discover.json'), 'utf8'),
  ) as unknown;
  assert.deepEqual(application.disclosure.discover(), expected);
  assert.equal(
    await application.publications.read('contexture://runbooks/crash-loop-backoff'),
    JSON.parse(await readFile(path.join(goldenDirectory, 'reads.json'), 'utf8'))[
      'contexture://runbooks/crash-loop-backoff'
    ],
  );
});
