import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const tag = process.argv[2];
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const conformance = JSON.parse(
  await readFile(new URL('../conformance/specification.json', import.meta.url), 'utf8'),
);

if (manifest.private !== false) {
  throw new Error('Refusing to publish while package.json private is not false.');
}
if (manifest.version === '0.0.0' || tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag ?? '<missing>'} does not match version ${manifest.version}.`);
}
if (conformance.status === 'scaffold') {
  throw new Error('Refusing to publish a scaffold as a public package.');
}
