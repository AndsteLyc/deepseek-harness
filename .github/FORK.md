# Fork release policy

English | [中文](FORK.zh.md)

## Official releases

The current official baseline is recorded by tag and source tree in [fork-release.json](fork-release.json). The application version equals that release. Published manifests also record `upstreamTag`, `upstreamCommit`, and the actual fork build commit so builds with the same version remain distinguishable.

`customPaths` lists the product files carrying this fork's customizations and the previously sealed archive records retained across the baseline adjustment. The release check rejects undeclared tracked or untracked changes, a tag with a different source tree, and a mismatched application version. The fork-owned `.github` directory holds its automation and this policy.

## Automatic updates

[Fork · Sync official release](workflows/fork-sync-release.yml) checks the official `dsh-v` tags every six hours and supports manual runs. It selects the highest semantic version, including prereleases, and proceeds only when it is newer than the current baseline. Development commits on upstream `master` are excluded.

The synchronizer applies the product changes from the old official release to the new tag with a three-way merge, preserving local customizations and the fork's automation. A conflict stops the run without committing or pushing. Successful preparation updates the baseline, installs the new locked dependencies, builds, and runs the customization checks. Only a verified result is committed and pushed to `custom`; packaging uses that exact commit. Future releases that change the customization APIs may require manual adaptation before these checks pass.

GitHub schedules require this workflow on the repository's default branch. Set the default branch to `custom` to activate the six-hour check. The packaging job disables both legacy workflows, whose default-branch copies could otherwise merge development code or publish it without the release check. The disabled legacy sync workflow cannot be manually dispatched; synchronization of the separate `master` mirror then requires local Git.

## Validation and history

Fetch the declared baseline tag from the official repository before local checks; both workflows do this explicitly. Run `node --test .github/scripts/verify-release-base.test.mjs .github/scripts/sync-release.test.mjs` and `node .github/scripts/verify-release-base.mjs` from the repository root. Packaging checks its baseline before dependency installation and publishes only after the packaged runtime smoke checks succeed.

The initial baseline adjustment is an ordinary commit on `custom`; previous commits remain in Git history. Commit counts therefore include earlier upstream merges and do not describe the current source differences from the official release.
