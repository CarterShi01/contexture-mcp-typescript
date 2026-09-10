# Releasing

The package is not publishable while `private` is `true` or conformance status
is `scaffold`. This is intentional.

## First public candidate

1. Start from current `master` with a clean worktree. Complete the release
   scope, move user-visible changes into a dated changelog section, and update
   both READMEs and handbooks.
2. Set `conformance/specification.json` to the honestly achieved status.
3. Change `private` to `false` and set a candidate version such as
   `0.1.0-rc.1` in `package.json`; regenerate `package-lock.json`.
4. Run `npm ci` and `npm run check`. Inspect `npm pack --dry-run` and confirm
   the tarball contains `LICENSE`, both READMEs, declarations, CLI, templates,
   and every documented public subpath, with no credentials or stale build
   output. The check installs that tarball into an independent consumer and
   exercises a generated project.
5. Commit, create the exact matching tag (`v0.1.0-rc.1`), and push it.
6. For the first npm upload, authenticate interactively with 2FA if the package
   does not yet exist. After ownership exists, configure npm Trusted Publishing:
   - GitHub user: `CarterShi01`
   - repository: `contexture-mcp-typescript`
   - workflow: `publish-npm.yml`
   - environment: `npm`
   - allowed action: `npm publish`

The workflow requires Node 24 and npm 11.19.1, validates tag/version equality,
runs the complete check, and publishes through OIDC without a long-lived token.
Protect the GitHub `npm` environment with a required reviewer.

Never reuse or move a published version tag.
