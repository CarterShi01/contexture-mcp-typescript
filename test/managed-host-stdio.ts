/** Executable trusted TEST Host; never production identity/approval credentials. */
import { hostFixture } from './managed-host-fixture.js';

const fixture = await hostFixture();
const adapter = fixture.adapter();
try {
  await adapter.serveStdio();
} finally {
  await adapter.close();
  await fixture.close();
}
