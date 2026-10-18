# Releasing

Releases are autonomous but human-gated. On every push to `main`,
`.github/workflows/release-please.yml` runs
[release-please](https://github.com/googleapis/release-please): it keeps
a **Release PR** open that accumulates the changelog and the
`package.json` version bump from conventional commits. The one human
click is merging that PR — release-please then creates the `v*` tag and
the GitHub release with categorized notes, and the same workflow
re-runs the full proof chain (lint, typecheck, tests, build, pack
checks, browser e2e) on the tagged commit before publishing to npm with
provenance.

Tags created by `GITHUB_TOKEN` don't fire `push: tags` workflows
(GitHub's recursion guard), which is why verify + publish live inside
`release-please.yml` itself.

## Cutting a release

1. Merge work PRs using conventional commits. The bot keeps the
   Release PR updated — review its changelog and proposed version.
2. Merge the Release PR. Tag, GitHub release, verify, and npm publish
   are all automatic.

No npm token is stored in the repo — publishing uses npm trusted
publishing (OIDC) only.

## Manual escape hatch

Pushing a `v*` tag still runs `.github/workflows/release.yml` (same
verify chain, then publish + GitHub release), for when the bot path
isn't usable:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release.yml` also triggers manually (**Actions → release → Run
workflow**). A `workflow_dispatch` run executes the same `verify` chain
but publishes with `npm publish --dry-run` and skips `gh release
create` — the full release path is exercised end-to-end without
shipping, useful before v0.1.0 exists or before cutting any new tag.

One narrowing to know: once a version is actually published, a
`workflow_dispatch` rehearsal on `main` fails the "version is unpublished
and newer" guard — `main`'s `package.json` still says the shipped
version. Rehearsals work again once a version bump lands on a branch;
that is expected, not a broken pipeline.

## Choosing the version bump

The table describes what release-please computes from conventional
commits since the last release. `bump-minor-pre-major` is set in
`release-please-config.json`, so a breaking change on 0.x bumps minor,
not major.

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
npm publish --access public
```

No `--provenance` on this one — it only works inside a supported CI
provider ("not supported for provider: null" locally), and a trusted
publisher cannot exist for a package that has never shipped. Provenance
attestation comes from the CI publish path afterwards.

Then connect the repo on npmjs.com: package **Settings → Trusted
Publisher → GitHub Actions**, with owner `JoShMiQueL`, repository
`crawlio`, and no environment. npm binds each publisher to a workflow
filename, so configure **two** publishers (npm allows multiple trusted
publishers per package):
`release-please.yml` for the bot path and `release.yml` for the manual
tag path.

## Hardening

After the trusted publishers are in place, set package **Settings →
Publishing access** to "Require two-factor authentication and disallow
tokens" — this blocks classic `NPM_TOKEN` publishes entirely, leaving
OIDC as the only path.
