# Repository instructions

These instructions apply to the entire TypeScript repository.

- English is the first language for code, identifiers, comments, errors, API
  documentation, release notes, and authoritative documentation. Simplified
  Chinese documents are translations.
- The normative contract is Contexture 0.12 at the revision pinned in
  `conformance/specification.json`. Start porting work at the reference
  repository's `spec/porting/TERRA_GOAL.md`; `spec/model.md`,
  `spec/conformance.md`, fixtures, and golden files outrank Python mechanisms.
- This repository is a scaffold implementing rule 1 only. Do not imply broader
  conformance or remove `private: true` until every rule has execution evidence.
- Never edit or replace expected golden bytes to make a test pass. Never weaken,
  skip, or delete a test to obtain green CI. A copied fixture or golden file is
  not execution evidence.
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

GPT-5.6 Terra high owns the continuous porting goal. Decisions in the reference
repository's `spec/porting/PORTING_BRIEF.md` are approved defaults and should be
implemented without pausing merely because a module is high-risk. This is one
uninterrupted Goal: stage reports, green commits, local blockers, and test
failures never trigger a handoff. Diagnose, reduce or reorder work, and continue
all independent tasks. Record specification/Python conflicts, required
normative or golden changes, unrecorded product-semantic decisions, and failures
unresolved after expanded diagnosis for one final GPT-5.6 Sol audit. End only
when both ports are complete or one irreducible blocker prevents every remaining
task after all safe alternatives are exhausted. Luna is limited to mechanical
work with an exact test oracle.
