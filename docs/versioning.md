# Versioning and releases

PrunerrXT follows [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
The version you see in the sidebar footer, in Settings and in `get_overview`
is the version of the image you are running.

## What happens on a push to main

Every push to `main` is a release. The `Release` workflow:

1. Runs the client and server checks (lint, typecheck, build, tests). A
   failing check stops the release; nothing is tagged or published.
2. Computes the next version. The major and minor numbers come from the
   `version` field in `package.json`; the patch number is the next free one
   after the newest `vMAJOR.MINOR.*` tag, starting at 0 when the pair is new.
3. Writes a section for that version into `CHANGELOG.md` from the commit
   subjects since the previous tag (merge commits and release commits left
   out), commits it as `Release vX.Y.Z`, tags `vX.Y.Z`, and pushes both.
4. Builds the image for amd64 and arm64 with `APP_VERSION=X.Y.Z` and publishes
   it as `:latest`, `:X.Y.Z`, `:X.Y` and `:X`.
5. Creates a GitHub release named `PrunerrXT X.Y.Z` with the same notes.

The release commit is pushed with the repository's own token, which does not
trigger workflows, so a release never starts another release.

## Choosing a new major or minor

Edit `version` in `package.json`, `client/package.json` and
`server/package.json` (the patch digit there is ignored, so `2.1.0` is the
conventional spelling) and push. The next release becomes `2.1.0`.

Before pushing, add a section headed `## 2.1.0 (unreleased)` to
`CHANGELOG.md` with the prose that explains the release. The workflow
completes it in place: the heading gets the date and the commit list is
appended under *Commits*. Without such a section the entry is the commit
list alone, which is fine for patches.

Bump the major for a change an existing install cannot simply pull, such as
a removed setting, a renamed environment variable or a schema migration that
cannot be undone. Bump the minor for a new feature. Everything else is a
patch, and patches need no thought at all.

## Image tags

| Tag | Meaning |
|---|---|
| `:latest` | The newest release. What a normal install runs. |
| `:2.0.4` | Exactly that release, pinned. |
| `:2.0`, `:2` | The newest patch of that minor, or of that major. |
| `:beta` | The `beta` branch, rebuilt on every push, version `beta-<sha>`. Not a release. |
| `:<name>` | A manual run of *Build and Push Docker Image* with a tag typed in, for one-off testing. Left empty, the branch name. |

An image whose version contains a dash (`beta-1a2b3c4`, `main-1a2b3c4`) is a
branch build and never claims to be a release.

## Where the version is read

`APP_VERSION` is a build argument of the Dockerfile and becomes an
environment variable in the image; `server/src/utils/version.ts` reads it,
falling back to `package.json` outside Docker. The client shows it in the
sidebar footer; the API returns it from `/api/health` and `/api/version`;
`get_overview` carries it to the assistant.

## Manual releases

There is no need for one. If a push to `main` must not release (a
documentation-only change, say), it still does, and that is harmless: the
image is rebuilt, the patch number advances, and the changelog records the
commit. If the workflow ever fails after tagging, re-run it from the Actions
tab; the version step is skipped only when its tag already exists on that
commit, otherwise fix the cause and push again.
