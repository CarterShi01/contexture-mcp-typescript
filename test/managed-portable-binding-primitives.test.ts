import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { BindingRegistration, GraphError, canonicalJSON, thawJSON } from '../src/managed.js';
import type { JSONObject } from '../src/managed.js';

test('candidate portable primitives execute captured native callables', async () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL('../conformance/managed/portable-binding-primitives.json', import.meta.url),
      'utf8',
    ),
  ) as {
    schema: string;
    contract_id: string;
    input_schema: JSONObject;
    cases: { id: string; input: unknown; expected: unknown }[];
  };
  assert.equal(corpus.schema, 'contexture.portable-binding-primitives/candidate-v1');
  const stages: string[] = [];
  const retained: { count: number; label: string; actor: string }[] = [];
  const resource = {};
  const identity = { actor_id: 'actor', tenant_id: 'tenant', authority_revision: '1' };
  const registration = BindingRegistration.create({
    binding_id: 'primitives',
    version: '1',
    kind: 'registered',
    portability: { kind: 'portable', contract_id: corpus.contract_id },
    effect: 'read_only',
    abi: 'typescript-managed-call/v1',
    artifact_digest: `sha256:${'a'.repeat(64)}`,
    input_schema: corpus.input_schema,
    validator_contract_id: 'count-range/v1',
    decoder_contract_id: 'decimal-count-label/v1',
    default_contract_id: 'count-two-label-default/v1',
    coercion_contract_id: 'bounded-decimal/v1',
    decoder: (arguments_) => {
      stages.push('decoder');
      if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_))
        throw new GraphError('schema_invalid', 'Expected object');
      const input = thawJSON(arguments_) as JSONObject;
      let count = input.count === undefined ? 2 : input.count;
      if (typeof count === 'string') {
        if (!/^(?:0|[1-9][0-9]?|-[1-9][0-9]?)$/.test(count) || count.endsWith('\n'))
          throw new GraphError('schema_invalid', 'Noncanonical bounded decimal');
        count = Number(count);
      }
      const label = input.label === undefined ? 'default' : input.label;
      if (typeof count !== 'number' || typeof label !== 'string')
        throw new GraphError('schema_invalid', 'Expected native fields');
      return { count: count === 0 ? 0 : count, label };
    },
    validator: (input) => {
      stages.push('validator');
      if (!Number.isInteger(input.count) || input.count < 0 || input.count > 9)
        throw new GraphError('schema_invalid', 'Count outside native contract');
    },
    handler: (input, context) => {
      stages.push('handler');
      assert.equal(context.resource, resource);
      assert.equal(context.identity, identity);
      const result = { ...input, actor: context.identity.actor_id };
      retained.push(result);
      return result;
    },
  });
  const observations = [];
  for (const candidate of corpus.cases) {
    stages.length = 0;
    const before = canonicalJSON(candidate.input);
    let actual: unknown;
    try {
      const result = await registration.call(candidate.input, {
        identity,
        resource,
        signal: undefined,
      });
      actual = { status: 'ok', stages: [...stages], output: thawJSON(result) };
      retained[retained.length - 1]!.label = 'mutated-after-call';
      assert.deepEqual(thawJSON(result), (actual as { output: unknown }).output);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      actual = { status: 'rejected', stages: [...stages] };
    }
    assert.deepEqual(canonicalJSON(candidate.input), before, candidate.id);
    assert.deepEqual(actual, candidate.expected, candidate.id);
    observations.push({ id: candidate.id, observation: actual });
  }
  if (process.env.CONTEXTURE_BINDING_OBSERVATIONS)
    writeFileSync(process.env.CONTEXTURE_BINDING_OBSERVATIONS, canonicalJSON(observations));
});
