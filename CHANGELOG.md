# Changelog

All notable changes will be documented here. This project follows Semantic
Versioning once public releases begin.

## Unreleased

## 0.13.0-rc.1

- Add path-aware `SurfaceSelection`, exact descendant promotion, and terminal
  `/*` direct-member expansion across disclosure, invocation, publications,
  completion, dependency cards, instructions, and request-local graphs.
- Add canonical `Contexture-Select` HTTP selection with path-aware identity
  ceilings; retain `RootSelection` and `Contexture-Roots` compatibility aliases.
- Return safe JSON-RPC invalid-params responses for invalid HTTP selectors and
  count selector header limits by Unicode code point.
- Keep the npm package private pending separate release authorization.

- Implement all 16 Contexture 0.12 conformance rules across declarations,
  compilation, disclosure, execution, publications, lifecycle, MCP, and REST.
- Add repository-local byte-identical fixtures and golden assets so a standalone
  clone can execute the conformance suite.
- Harden nested schema immutability, publication snapshots, and cleanup error
  preservation during the final acceptance audit.
- Publish maintained `core`, `server/surface`, `demo`, and `web` package
  subpaths with installed-package consumer verification.
- Complete fixed/request-selected server assembly, Prompt/Resource projection,
  and exported Kubernetes demo Tool factories.
- Keep the first npm release guarded pending package-name and release review.
