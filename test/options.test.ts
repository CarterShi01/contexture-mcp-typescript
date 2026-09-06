import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextureOptions, ServeError } from '../src/server/index.js';

test('serve options preserve safe local defaults and reject contradictory or public startup', () => {
  const local = new ContextureOptions({ transport: 'streamable-http' });
  assert.equal(local.url, 'http://127.0.0.1:8000/mcp');
  assert.equal(local.logLevel, 'info');
  assert.throws(() => new ContextureOptions({ logLevel: 'verbose' as never }), ServeError);
  assert.throws(() => new ContextureOptions({ host: '127.0.0.1' }), ServeError);
  assert.throws(
    () => new ContextureOptions({ transport: 'streamable-http', host: '0.0.0.0' }),
    /allowedHosts and\/or allowedOrigins/,
  );
  assert.throws(
    () =>
      new ContextureOptions({
        transport: 'streamable-http',
        host: '0.0.0.0',
        allowedHosts: ['localhost'],
      }),
    /allowAnonymous/,
  );
  assert.doesNotThrow(
    () =>
      new ContextureOptions({
        transport: 'streamable-http',
        host: '0.0.0.0',
        allowedHosts: ['localhost'],
        allowAnonymous: true,
      }),
  );
});
