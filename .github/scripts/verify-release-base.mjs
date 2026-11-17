/** Verify that fork builds contain only the declared changes to an official release. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reject a moved release tag, a changed version, or undeclared product changes.
 * @param {string} root - Git worktree containing the fork release declaration.
 * @returns {{upstreamTag: string, upstreamCommit: string, changedPaths: string[]}} Verified release and changed paths.
 */
export function verifyReleaseBase(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const config = JSON.parse(readFileSync(resolve(root, '.github/fork-release.json'), 'utf8'))
  if (!/^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(config.upstreamTag)
    || !/^[0-9a-f]{40}$/.test(config.upstreamTree)
    || !Array.isArray(config.customPaths)
    || !config.customPaths.every(path => typeof path === 'string' && path.length > 0)) {
    throw new Error('Invalid .github/fork-release.json: declare an official tag, its source tree, and customPaths')
  }
  const commit = git('rev-parse', `refs/tags/${config.upstreamTag}^{commit}`)
  const tree = git('rev-parse', `refs/tags/${config.upstreamTag}^{tree}`)
  if (tree !== config.upstreamTree) {
    throw new Error(`Release tag ${config.upstreamTag} does not match the pinned upstream tree`)
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (`dsh-v${manifest.version}` !== config.upstreamTag) {
    throw new Error(`Fork version ${manifest.version} does not match ${config.upstreamTag}`)
  }
  const output = execFileSync('git', ['-C', root, 'diff', '--no-renames', '--name-only', '-z', commit, '--'], { encoding: 'utf8' })
  const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  const changedPaths = [...new Set((output + untracked).split('\0').filter(Boolean))]
  const allowed = new Set(config.customPaths)
  const unexpected = changedPaths.filter(path => !path.startsWith('.github/') && !allowed.has(path))
  if (unexpected.length > 0) {
    throw new Error(`Undeclared changes outside the official release: ${unexpected.join(', ')}`)
  }
  return { upstreamTag: config.upstreamTag, upstreamCommit: commit, changedPaths }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = verifyReleaseBase(root)
  console.log(`Verified ${result.upstreamTag}: ${result.changedPaths.length} declared fork paths`)
}
