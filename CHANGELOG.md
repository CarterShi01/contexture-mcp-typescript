# Changelog

All notable changes will be documented here. This project follows Semantic
Versioning once public releases begin.

## Unreleased

## 0.15.0-rc.1

- Add the read-only `contexture_inspect(refs)` gateway for atomically comparing
  one through 32 unique candidate refs without activating them.
- Return only pure routing cards for each target, its direct members, and its
  declared uses; omit instructions, execution facets, Publication contracts,
  content, results, and recursive expansion.
- Keep inspection evidence separate from ACTIVE Role/Skill and Tool telemetry,
  and expose discover, inspect, and open on disclosure-only applications.
- Preserve the existing local `contexture inspect` CLI trace command unchanged.
- Pin Contexture Specification 0.15 and conformance rule 17 to immutable Python
  revision `471d0f75c6be0e5cff104f0d0c61f10957da792a`.

## 0.14.0-rc.1

- Add runtime-branded optional Role Publications with complete containment,
  selection, inspection, disclosure-only, and ControllerManager support.
- Keep Publications as ordinary Roles on the wire while excluding them from
  alternative-work branch traversal and initialization rosters.
- Compose a framework-owned closing contract only on an owning Role's ACTIVE
  disclosure; opening never executes Publication equipment or claims success.
- Keep the npm package private pending separate release authorization.

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
