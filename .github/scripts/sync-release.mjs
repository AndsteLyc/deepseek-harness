/** Prepare a clean fork checkout for an official DSH release candidate without committing or pushing. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { verifyReleaseBase } from './verify-release-base.mjs'

const OFFICIAL_UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git'
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024

/**
 * Select the highest valid DSH release candidate from ls-remote output.
 * Annotated tags retain their tag-object identity and peeled entries are ignored.
 * @param {string} output - Output of git ls-remote --tags.
 * @returns {{tag: string, version: string, object: string} | undefined} Highest RC tag, if one exists.
 */
export function selectLatestReleaseTag(output) {
  const releases = output.split(/\r?\n/).flatMap(line => {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(dsh-v\d+\.\d+\.\d+-rc\.\d+)$/u.exec(line)
    if (match === null) return []
    const version = semver.valid(match[2].slice('dsh-v'.length))
    return version === null ? [] : [{ tag: match[2], version, object: match[1] }]
  })
  return releases.sort((left, right) => semver.rcompare(left.version, right.version))[0]
}

/**
 * Apply product changes from the pinned release to the highest newer official RC.
 * Leave the checkout unchanged when no newer RC exists. The caller must provide a clean,
 * disposable checkout. Conflicts throw and leave the index available for diagnosis.
 * @param {string} root - Clean fork worktree containing its baseline declaration.
 * @param {{upstream?: string}} options - Official repository, overridden by a private repository in tests.
 * @returns {{changed: boolean, tag: string, upstreamCommit: string}} Prepared release identity.
 */
export function prepareRelease(root, { upstream = OFFICIAL_UPSTREAM } = {}) {
  const run = (args, options = {}) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  })
  const git = (...args) => run(args).trim()
  if (git('status', '--porcelain', '--untracked-files=normal') !== '') {
    throw new Error('Official release synchronization requires a clean, disposable Git checkout')
  }
  const previous = verifyReleaseBase(root)
  const previousVersion = semver.valid(previous.upstreamTag.slice('dsh-v'.length))
  if (previousVersion === null) throw new Error('The pinned official release is not a semantic version')
  const selected = selectLatestReleaseTag(git('ls-remote', '--tags', upstream, 'refs/tags/dsh-v*-rc.*'))
  if (selected === undefined || !semver.gt(selected.version, previousVersion)) {
    return { changed: false, tag: previous.upstreamTag, upstreamCommit: previous.upstreamCommit }
  }

  git('fetch', '--no-tags', upstream, `refs/tags/${selected.tag}:refs/tags/${selected.tag}`)
  if (git('rev-parse', `refs/tags/${selected.tag}`) !== selected.object) {
    throw new Error(`Official release tag ${selected.tag} moved while it was being fetched`)
  }
  const upstreamCommit = git('rev-parse', `refs/tags/${selected.tag}^{commit}`)
  const upstreamTree = git('rev-parse', `refs/tags/${selected.tag}^{tree}`)
  const patch = run([
    'diff', '--binary', '--full-index', '--no-renames', previous.upstreamCommit, upstreamCommit,
    '--', '.', ':(exclude).github',
  ], { encoding: 'buffer' })
  if (patch.length > 0) {
    try {
      run(['apply', '--3way', '--index', '--whitespace=nowarn'], { input: patch })
    } catch (error) {
      const diagnostic = error.stderr?.toString().trim() ?? error.message
      throw new Error(`Official release ${selected.tag} could not be merged; no commit or push was attempted.\n${diagnostic}`, { cause: error })
    }
  }
  const declaration = resolve(root, '.github/fork-release.json')
  const config = JSON.parse(readFileSync(declaration, 'utf8'))
  writeFileSync(declaration, `${JSON.stringify({ ...config, upstreamTag: selected.tag, upstreamTree }, null, 2)}\n`)
  verifyReleaseBase(root)
  git('add', '--', '.github/fork-release.json')
  return { changed: true, tag: selected.tag, upstreamCommit }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = prepareRelease(root)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\ntag=${result.tag}\n`)
  }
  console.log(result.changed ? `Prepared official RC ${result.tag}` : `No official RC newer than ${result.tag}`)
}
