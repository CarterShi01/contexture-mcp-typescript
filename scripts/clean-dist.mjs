import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.resolve(repositoryRoot, 'dist');

if (path.dirname(outputDirectory) !== repositoryRoot) {
  throw new Error('Refusing to clean output outside this repository: ' + outputDirectory);
}

await rm(outputDirectory, { force: true, recursive: true });
