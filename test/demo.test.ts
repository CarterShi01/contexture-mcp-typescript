import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { deploymentOps, incidentResponse, kubernetesPlatform } from '../src/demo/role.js';
import {
  getPodEvents,
  getPodLogs,
  getPodStatus,
  getRolloutStatus,
  rollBackDeployment,
} from '../src/demo/tools.js';
import {
  app,
  build,
  crashLoopRunbookDocument,
  main,
  rollBackARelease,
  rollbackPolicyDocument,
} from '../src/demo/server.js';
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

test('demo facade exposes one lazy topology, publications, and non-starting server builder', () => {
  assert.equal(kubernetesPlatform().name, 'kubernetes-platform');
  assert.equal(incidentResponse().name, 'incident-response');
  assert.equal(deploymentOps().name, 'deployment-ops');
  assert.equal(app.roots.length, 1);
  assert.deepEqual(app.prompts?.[0], rollBackARelease);
  assert.deepEqual(app.resources, [crashLoopRunbookDocument, rollbackPolicyDocument]);
  assert.equal(build().name, 'contexture-demo');
  assert.equal(typeof main, 'function');
});

test('demo tool factories preserve fixed evidence, write classification, and domain failures', async () => {
  const input = { namespace: 'prod', pod: 'payments-api-7d9c' };
  assert.equal((await getPodStatus().invoke(input, {})).restart_count, 14);
  assert.match(await getPodLogs().invoke({ ...input, previous: true }, {}), /DB_URL is missing/);
  assert.equal((await getPodEvents().invoke(input, {}))[3]?.reason, 'Unhealthy');
  assert.equal(
    (await getRolloutStatus().invoke({ namespace: 'prod', deployment: 'payments-api' }, {}))
      .previous_revision,
    8,
  );
  const rollback = rollBackDeployment();
  assert.equal(rollback.readOnly, false);
  assert.match(
    await rollback.invoke({ namespace: 'prod', deployment: 'payments-api' }, {}),
    /revision 9 to 8/,
  );
  await assert.rejects(
    async () => getPodStatus().invoke({ namespace: 'prod', pod: 'unknown' }, {}),
    /single fixed incident/,
  );
});
