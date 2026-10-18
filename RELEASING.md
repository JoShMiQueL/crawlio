# Releasing

Releases are tag-driven: pushing a `v*` tag runs
`.github/workflows/release.yml`, which re-runs the full proof chain
(lint, typecheck, tests, build, pack checks, browser e2e) on the tagged
commit, then publishes to npm with provenance and creates the GitHub
release.

## Cutting a release

1. Open a PR bumping `version` in `package.json` (semver). Merge it.
2. Tag the merge commit and push:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The workflow verifies the tag equals `v` + `package.json` version,
   then publishes `crawlio` to npm and creates the GitHub release with
   generated notes. The bump itself is manual — the workflow only
   enforces that the version is unpublished and above npm's `latest`.

No npm token is stored in the repo — publishing uses npm trusted
publishing (OIDC) only.

## Rehearsing a release

The workflow also triggers manually (**Actions → release → Run
workflow**). A `workflow_dispatch` run executes the same `verify` chain
but publishes with `npm publish --dry-run` and skips `gh release
create` — the full release path is exercised end-to-end without
shipping, useful before v0.1.0 exists or before cutting any new tag.

## Choosing the version bump

| Change since the last release | Bump |
| --- | --- |
| `feat` — new SDK surface | minor |
| `fix`, `perf` | patch |
| breaking API change while 0.x | minor (0.x has no major line to burn) |
| `docs`, `ci`, `chore`, `test` only | no release on its own |
| breaking API change from 1.0 | major |

## First publish is manual

npm can't configure a trusted publisher for a package that doesn't
exist yet, so v0.1.0 ships by hand:

```sh
npm login
npm publish --provenance --access public
```

Then connect the repo on npmjs.com: package **Settings → Trusted
Publisher → GitHub Actions**, with owner `JoShMiQueL`, repository
`crawlio`, workflow `release.yml`, and no environment. Every release
after that publishes through the workflow.

## Hardening

After the trusted publisher is in place, set package **Settings →
Publishing access** to "Require two-factor authentication and disallow
tokens" — this blocks classic `NPM_TOKEN` publishes entirely, leaving
OIDC as the only path.
