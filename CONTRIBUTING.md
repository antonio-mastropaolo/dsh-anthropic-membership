# Contributing

PRs welcome on this plugin repo.

DeepSeek Harness itself does not accept external pull requests. File harness bugs in [DSH Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

```sh
npm test
```

## Cutting a release

Only the maintainer does this; contributors never need npm access.

1. On `main`, with CI green, bump `version` in `package.json` (`npm version --no-git-tag-version <x.y.z>`).
2. In `CHANGELOG.md` change the heading `## [x.y.z] - Unreleased` to `## [x.y.z] - YYYY-MM-DD` (the release job refuses an undated or missing section and uses that section as the GitHub release notes).
3. Commit (`dsh-model-hub: release x.y.z`) and merge to `main`.
4. Tag that commit and push the tag: `git tag -a vx.y.z -m "vx.y.z" && git push origin vx.y.z`.
5. The `Release` workflow runs on the tag: it checks that the tag equals `package.json`'s version and that the commit is on `main`, runs the tests, packs the tarball once, publishes exactly that tarball to npm with provenance, then creates the GitHub release with the tarball attached.

The npm token is held by the repository owner only. It is stored as the `NPM_TOKEN` secret of the `npm-release` environment (tag-restricted, owner approval required), so it is never available to pull requests, forks or ordinary workflows. If you fork, the release workflow does not run (`github.repository` check).
