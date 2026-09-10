# Contributing

Thank you for improving the TypeScript binding.

## Set up

Use Node.js 20.19 or newer and npm 11:

```bash
npm ci
npm run check
```

`npm run check` runs conformance validation, formatting, lint, type checking,
the complete test suite, build and pack checks, and both installed-package and
generated-scaffold consumers.

Create changes from `master`. Do not commit credentials, local environment
files, `node_modules`, coverage output, or built distributions.

## Contracts

- English is the primary language for code, comments, errors, API docs, commits,
  and review discussion. User-facing Simplified Chinese docs are translations.
- `src/core` must remain independent of every MCP or HTTP SDK.
- Language-native APIs are encouraged; observable behavior must follow the
  pinned Contexture specification and golden fixtures.
- Update `conformance/specification.json` only after reviewing the upstream
  specification diff and proving newly claimed rules with tests.
- Do not change package visibility or publish a release from incomplete status.

Public API changes require tests and a changelog entry. Wire-level changes also
require a conformance-fixture review in the reference repository.
Describe the user-visible problem, chosen boundary, tests, and compatibility
effect in each pull request. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), never in a public issue.
