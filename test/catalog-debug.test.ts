import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { Contexture } from '../src/index.js';
import { compileRuntimeApplication } from '../src/server/application.js';
import { CatalogDebugServer } from '../src/debug.js';
import { ModelValidationError } from '../src/core/foundation/errors.js';

function debug() {
  const compiled = compileRuntimeApplication(
    Contexture({
      name: 'debug-fixture',
      roots: [
        () => ({
          kind: 'role',
          name: 'root',
          description: '<script>Not HTML</script>',
          instructions: 'Private authored program.',
          skills: [
            () => ({
              kind: 'skill',
              name: 'leaf',
              description: 'Leaf.',
              instructions: 'Leaf program.',
            }),
          ],
        }),
      ],
    }),
  );
  return compiled.debug();
}

function raw(url: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{
    status: number;
    headers: Readonly<Record<string, string | string[] | undefined>>;
    body: string;
  }>((resolve, reject) => {
    const operation = request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode!,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      response.on('error', reject);
    });
    operation.on('error', reject);
    operation.end();
  });
}

test('native debug serves immutable Catalog and reused UI assets on an actual loopback listener', async () => {
  const server = debug();
  assert.ok(server instanceof CatalogDebugServer);
  const address = await server.start();
  try {
    assert.equal(address.host, '127.0.0.1');
    const document = await raw(address.url);
    assert.equal(document.status, 200);
    assert.match(document.body, /Contexture Node Catalog/);
    assert.ok(!document.body.includes('<script>Not HTML</script>'));
    assert.equal(document.headers['x-content-type-options'], 'nosniff');
    assert.equal(document.headers['x-frame-options'], 'DENY');
    assert.match(String(document.headers['content-security-policy']), /frame-ancestors 'none'/);
    const catalog = await raw(`${address.url}/api/catalog`);
    const body = JSON.parse(catalog.body);
    assert.equal(body.schema, 'contexture.node-catalog/v1');
    assert.equal(body.application.detail, 'definition');
    assert.equal(body.nodes[0].role.authored_instructions, 'Private authored program.');
    assert.equal(catalog.headers.etag, `"${server.catalog.snapshot().contentDigest}"`);
    assert.equal((await raw(`${address.url}/app.css`)).status, 200);
    assert.match((await raw(`${address.url}/app.js`)).body, /textContent/);
    assert.equal((await raw(`${address.url}/healthz`)).body, '{"status":"ok"}');
    assert.equal(
      JSON.parse((await raw(`${address.url}/api/nodes/root%2Fleaf`)).body).ref,
      'root/leaf',
    );
  } finally {
    await address.close();
    await address.close();
  }
});

test('debug rejects write routes and Host/Origin rebinding without revealing metadata', async () => {
  const address = await debug().start();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await raw(`${address.url}/api/catalog`, { method });
      assert.equal(response.status, 405);
      assert.ok(!response.body.includes('Private authored program'));
    }
    for (const host of [
      'evil.example',
      'evil.example@127.0.0.1',
      '127.0.0.1/evil',
      '127.0.0.1:999999',
    ]) {
      const response = await raw(`${address.url}/api/catalog`, { headers: { Host: host } });
      assert.equal(response.status, 400);
      assert.ok(!response.body.includes('Private authored program'));
    }
    assert.equal(
      (await raw(`${address.url}/api/catalog`, { headers: { Origin: 'https://evil.example' } }))
        .status,
      403,
    );
    assert.equal(
      (await raw(`${address.url}/api/catalog`, { headers: { Origin: address.url } })).status,
      200,
    );
    assert.equal((await raw(`${address.url}/api/nodes/%E0%A4%A`)).status, 400);
    assert.equal((await raw(`${address.url}/api/nodes/missing`)).status, 404);
    assert.equal((await raw(`${address.url}/invoke`)).status, 404);
  } finally {
    await address.close();
  }
});

test('debug exact ETag and HEAD routes return no body; invalid bind never becomes remote', async () => {
  const server = debug();
  for (const host of ['0.0.0.0', '::', 'example.com', '127.1']) {
    await assert.rejects(server.start({ host }), ModelValidationError);
  }
  for (const port of [-1, 65536, 1.5])
    await assert.rejects(server.start({ port }), ModelValidationError);
  const address = await server.start();
  try {
    await assert.rejects(server.start(), ModelValidationError);
    const response = await raw(`${address.url}/api/catalog`);
    const tag = response.headers.etag;
    assert.equal(typeof tag, 'string');
    const notModified = await raw(`${address.url}/api/catalog`, {
      headers: { 'If-None-Match': String(tag) },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body, '');
    const head = await raw(`${address.url}/api/catalog`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
    assert.equal((await raw(`${address.url}/`, { method: 'HEAD' })).status, 404);
  } finally {
    await address.close();
  }
  const reopened = await server.start();
  await reopened.close();
});
