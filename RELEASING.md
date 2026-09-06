# Releasing

The package is not publishable while `private` is `true` or conformance status
is `scaffold`. This is intentional.

## First public candidate

1. Complete the release scope and tests.
2. Set `conformance/specification.json` to the honestly achieved status.
3. Change `private` to `false` and set a candidate version such as
   `0.1.0-rc.1` in `package.json`; regenerate `package-lock.json`.
4. Run `npm run check` and inspect `npm pack --dry-run`.
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
