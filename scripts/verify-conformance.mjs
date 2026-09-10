import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const manifest = JSON.parse(readFileSync('conformance/specification.json', 'utf8'));
const schema = JSON.parse(readFileSync('conformance/specification.schema.json', 'utf8'));
const specificationSource = readFileSync('src/core/foundation/specification.ts', 'utf8');

const expectedRevision = 'a108b314bb3f37622fb082759f726468bbb09163';
const expectedVersion = '0.14';
const expectedFixtures = [
  'disclosure-only-application.json',
  'prompt-roots-application.json',
  'reference-application.json',
  'rest-routes.json',
  'root-selections.json',
];
const expectedGolden = [
  'commands.json',
  'completions.json',
  'discover.json',
  'instructions.txt',
  'open.json',
  'prompts.json',
  'reads.json',
  'refusals.json',
  'resources.json',
  'tools.json',
];
const ruleNumbers = Array.from({ length: 16 }, (_, index) => index + 1);
const ruleStatuses = new Set(['not-started', 'in-progress', 'implemented']);

function fail(message) {
  throw new Error(`invalid conformance metadata: ${message}`);
}

function equalArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

const allowedKeys = new Set([
  '$schema',
  'repository',
  'revision',
  'specificationVersion',
  'status',
  'implementedRules',
  'rules',
  'fixtures',
  'golden',
  'notes',
]);
for (const key of Object.keys(manifest)) {
  if (!allowedKeys.has(key)) fail(`unknown manifest field ${key}`);
}
for (const key of [
  'repository',
  'revision',
  'specificationVersion',
  'status',
  'implementedRules',
  'rules',
  'fixtures',
  'golden',
]) {
  if (!(key in manifest)) fail(`missing manifest field ${key}`);
}
if (
  manifest.revision !== expectedRevision ||
  !specificationSource.includes(`'${expectedRevision}'`)
)
  fail('revision pin is not synchronized');
if (
  manifest.specificationVersion !== expectedVersion ||
  !specificationSource.includes(`'${expectedVersion}'`)
)
  fail('specification version is not synchronized');
if (!equalArray(manifest.fixtures, expectedFixtures))
  fail('fixture inventory is incomplete or unordered');
if (!equalArray(manifest.golden, expectedGolden))
  fail('golden inventory is incomplete or unordered');

const expectedRuleKeys = ruleNumbers.map(String);
if (
  typeof manifest.rules !== 'object' ||
  manifest.rules === null ||
  !equalArray(Object.keys(manifest.rules), expectedRuleKeys)
)
  fail('rules must contain exactly 1 through 16 in order');
const implemented = [];
for (const number of ruleNumbers) {
  const entry = manifest.rules[String(number)];
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !equalArray(Object.keys(entry).sort(), ['evidence', 'status'])
  )
    fail(`rule ${number} has an invalid shape`);
  if (!ruleStatuses.has(entry.status)) fail(`rule ${number} has an invalid status`);
  if (
    !Array.isArray(entry.evidence) ||
    entry.evidence.some((value) => typeof value !== 'string' || value.length === 0) ||
    new Set(entry.evidence).size !== entry.evidence.length
  )
    fail(`rule ${number} has invalid evidence`);
  if (entry.status === 'implemented') {
    if (entry.evidence.length === 0) fail(`rule ${number} needs evidence`);
    for (const evidence of entry.evidence) {
      if (!existsSync(evidence)) fail(`rule ${number} evidence does not exist: ${evidence}`);
    }
    implemented.push(number);
  }
}
for (const fixture of expectedFixtures) {
  if (!existsSync(`conformance/fixtures/${fixture}`)) fail(`fixture asset is missing: ${fixture}`);
}
for (const golden of expectedGolden) {
  if (!existsSync(`conformance/golden/${golden}`)) fail(`golden asset is missing: ${golden}`);
}
if (!equalArray(manifest.implementedRules, implemented))
  fail('implementedRules disagrees with rule statuses');
const expectedStatus =
  implemented.length === 16 ? 'conformant' : equalArray(implemented, [1]) ? 'scaffold' : 'partial';
if (manifest.status !== expectedStatus) fail(`status must be ${expectedStatus}`);
if (
  !equalArray(schema.required, [
    'repository',
    'revision',
    'specificationVersion',
    'status',
    'implementedRules',
    'rules',
    'fixtures',
    'golden',
  ])
)
  fail('vendored schema required fields drifted');
if (!equalArray(schema.properties.rules.required, expectedRuleKeys))
  fail('vendored schema does not require all rules');

process.stdout.write('conformance metadata is valid\n');
