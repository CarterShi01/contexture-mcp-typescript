# Repository instructions

These instructions apply to the entire TypeScript repository.

- English is the first language for code, identifiers, comments, errors, API
  documentation, release notes, and authoritative documentation. Simplified
  Chinese documents are translations.
- The normative contract is the manifest-pinned Contexture release, currently
  0.16, at the revision recorded in `conformance/specification.json`. The reference repository's
  `spec/porting/FULL_PRODUCT_PARITY_PLAN.md` governs completion. The older
  kernel ledger is evidence, not the product-completion criterion;
  `spec/model.md`, `spec/conformance.md`, fixtures, and golden files outrank
  Python mechanisms.
- This repository is a coordinated v1 release candidate. Claim Python-product
  equivalence, publish an npm package, or create a release tag only after the
  product and incremental manifests, ecosystem metadata and byte-identity gate,
  current Host evidence, and all release gates are verified and the release is
  separately authorized.
- Never edit or replace expected golden bytes to make a test pass. Never weaken,
  skip, or delete a test to obtain green CI. A copied fixture or golden file is
  not execution evidence.
- `conformance/fixtures` and `conformance/golden` are byte-identical snapshots
  from the pinned reference revision. Tests must produce outputs through this
  implementation before comparing them with those assets.
- Keep the core SDK-neutral. Runtime interfaces need explicit validators because
  TypeScript types are erased. Couple each Tool's runtime schema, validation,
  and inferred handler input in one Binding.
- Preserve declaration order and request isolation. Do not use `any` as a
  shortcut around a contract boundary.
- Keep one kernel concept or one Host adapter per review unit.

Run the full gate with:

```bash
npm ci
npm run check
```

GPT-5.6 Terra high owns bounded implementation slices from the product
manifest. GPT-5.6 Sol owns baseline changes, architecture, differential-test
design, and final acceptance. This is one uninterrupted Goal: stage reports,
green commits, local blockers, and test failures never trigger a handoff.
Diagnose, reduce or reorder work, and continue all independent tasks. Luna is
limited to mechanical work with an exact test oracle.
