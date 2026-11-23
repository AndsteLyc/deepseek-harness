/** Real Git repositories exercise release selection and patch-based upgrades independently of branch ancestry. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { prepareRelease, selectLatestReleaseTag } from './sync-release.mjs'

const OLD_TAG = 'dsh-v0.2.2-rc.3'
const NEXT_TAG = 'dsh-v0.2.2-rc.4'
const BASE_STYLE = [
  ':root {',
  '  --accent: blue;',
  '  --background: white;',
  '  --foreground: black;',
  '  --border: gray;',
  '  --radius: 8px;',
  '}',
  '',
  '.panel {',
  '  padding: 8px;',
  '  margin: 0;',
  '  overflow: auto;',
  '}',
  '',
].join('\n')

function fixture(t, { releaseAlreadyAncestor = false, baselineVersion = '0.2.2-rc.3' } = {}) {
  const baselineTag = `dsh-v${baselineVersion}`
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-official-release-sync-'))
  t.after(() => {
    assert.ok(basename(resolve(temporary)).startsWith('dsh-official-release-sync-'))
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const upstream = join(temporary, 'upstream')
  const root = join(temporary, 'fork')
  mkdirSync(upstream)
  const execute = (directory, args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const upstreamGit = (...args) => execute(upstream, args)
  const git = (...args) => execute(root, args)
  const writeAt = (directory, path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  const writeUpstream = (path, text) => writeAt(upstream, path, text)
  const write = (path, text) => writeAt(root, path, text)
  const configure = directory => {
    execute(directory, ['config', 'user.name', 'Release sync test'])
    execute(directory, ['config', 'user.email', 'release-sync@example.invalid'])
    execute(directory, ['config', 'core.hooksPath', '/dev/null'])
    execute(directory, ['config', 'commit.gpgsign', 'false'])
    execute(directory, ['config', 'tag.gpgsign', 'false'])
  }
  upstreamGit('init', '--initial-branch=master')
  configure(upstream)
  writeUpstream('package.json', JSON.stringify({ version: baselineVersion }))
  writeUpstream('custom.css', BASE_STYLE)
  writeUpstream('api.js', 'export const authenticatedUrl = true\n')
  writeUpstream('.github/workflows/upstream.yml', 'name: old official automation\n')
  upstreamGit('add', '.')
  upstreamGit('commit', '-m', 'official release')
  upstreamGit('tag', baselineTag)
  const base = upstreamGit('rev-parse', 'HEAD')
  const tree = upstreamGit('rev-parse', 'HEAD^{tree}')

  const release = (version = '0.2.2-rc.4', { conflict = false, annotated = false, manifestVersion = version } = {}) => {
    upstreamGit('checkout', '-B', 'release-next', base)
    writeUpstream('package.json', JSON.stringify({ version: manifestVersion }))
    writeUpstream('custom.css', conflict
      ? BASE_STYLE.replace('--accent: blue', '--accent: red')
      : BASE_STYLE.replace('padding: 8px', 'padding: 12px'))
    writeUpstream('api.js', 'export const authenticatedUrl = true\nexport const releasedApi = true\n')
    writeUpstream('.github/workflows/upstream.yml', 'name: new official automation\n')
    writeUpstream('.github/workflows/new-upstream.yml', 'name: new upstream workflow\n')
    upstreamGit('add', '.')
    upstreamGit('commit', '-m', `official ${version}`)
    const tag = `dsh-v${version}`
    if (annotated) upstreamGit('tag', '-a', tag, '-m', `Official ${version}`)
    else upstreamGit('tag', tag)
    return { tag, commit: upstreamGit('rev-parse', 'HEAD'), tree: upstreamGit('rev-parse', 'HEAD^{tree}') }
  }
  const development = () => {
    upstreamGit('checkout', '-B', 'master')
    writeUpstream('master-only.js', 'export const unreleasedApi = true\n')
    writeUpstream('api.js', 'export const authenticatedUrl = false\n')
    upstreamGit('add', '.')
    upstreamGit('commit', '-m', 'unreleased development API changes')
  }
  if (releaseAlreadyAncestor) {
    release()
    development()
  }
  execFileSync('git', ['clone', '--no-hardlinks', upstream, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  configure(root)
  git('checkout', '-B', 'custom')
  // Model the actual fork: old development commits remain reachable, but the product tree was restored.
  if (releaseAlreadyAncestor) git('read-tree', '--reset', '-u', base)
  write('custom.css', BASE_STYLE.replace('--accent: blue', '--accent: green'))
  write('.github/workflows/upstream.yml', 'name: fork-owned automation\n')
  write('.github/fork-release.json', `${JSON.stringify({ upstreamTag: baselineTag, upstreamTree: tree, customPaths: ['custom.css'] }, null, 2)}\n`)
  git('add', '.')
  git('commit', '-m', 'fork customization over pinned release')
  return { root, upstream, git, upstreamGit, write, release, development, head: git('rev-parse', 'HEAD') }
}

function preparedDeclaration(f) {
  return JSON.parse(readFileSync(join(f.root, '.github/fork-release.json'), 'utf8'))
}

test('selects the highest official RC by semantic version', () => {
  const object = 'a'.repeat(40)
  const rejected = [
    'dsh-v0.2.2', 'dsh-v0.2.3-alpha.1', 'dsh-v0.2.3-beta.1',
    'dsh-v99.0.0-rc.1^{}', 'fork-v100.0.0-rc.1', 'dsh-v0.3.0-rc.01', 'dsh-v0.3.0-rc.1.extra',
  ].map(tag => `${object}\trefs/tags/${tag}`)
  const rc = ['dsh-v0.2.2-rc.9', 'dsh-v0.2.2-rc.10', 'dsh-v0.2.1-rc.20']
    .map(tag => `${object}\trefs/tags/${tag}`)
  assert.deepEqual(selectLatestReleaseTag([...rejected, ...rc].join('\n')), {
    tag: 'dsh-v0.2.2-rc.10', version: '0.2.2-rc.10', object,
  })
  assert.equal(selectLatestReleaseTag(rejected.join('\n')), undefined)
})

test('leaves a clean fork unchanged when no newer official version exists', t => {
  const f = fixture(t)
  const before = readFileSync(join(f.root, '.github/fork-release.json'), 'utf8')
  const result = prepareRelease(f.root, { upstream: f.upstream })
  assert.equal(result.changed, false)
  assert.equal(result.tag, OLD_TAG)
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
  assert.equal(readFileSync(join(f.root, '.github/fork-release.json'), 'utf8'), before)
})

test('keeps a pinned alpha until a newer RC is available', t => {
  const f = fixture(t, { baselineVersion: '0.2.3-alpha.2' })
  const baseline = preparedDeclaration(f)
  f.release('0.2.3-alpha.3')
  const unchanged = { changed: false, tag: baseline.upstreamTag, upstreamCommit: f.git('rev-parse', baseline.upstreamTag) }
  assert.deepEqual(prepareRelease(f.root, { upstream: f.upstream }), unchanged)
  f.release('0.2.2-rc.5')
  assert.deepEqual(prepareRelease(f.root, { upstream: f.upstream }), unchanged)
  assert.deepEqual(preparedDeclaration(f), baseline)
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
})

test('merges a new RC with local customizations, preserving fork automation and excluding development master', t => {
  const f = fixture(t)
  const next = f.release()
  f.release('0.2.3-alpha.1')
  f.release('0.2.2')
  f.development()
  const result = prepareRelease(f.root, { upstream: f.upstream })
  assert.deepEqual(result, { changed: true, tag: NEXT_TAG, upstreamCommit: next.commit })
  assert.deepEqual(preparedDeclaration(f), { upstreamTag: NEXT_TAG, upstreamTree: next.tree, customPaths: ['custom.css'] })
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version, '0.2.2-rc.4')
  assert.match(readFileSync(join(f.root, 'custom.css'), 'utf8'), /--accent: green/)
  assert.match(readFileSync(join(f.root, 'custom.css'), 'utf8'), /padding: 12px/)
  assert.match(readFileSync(join(f.root, 'api.js'), 'utf8'), /authenticatedUrl = true/)
  assert.match(readFileSync(join(f.root, 'api.js'), 'utf8'), /releasedApi = true/)
  assert.equal(readFileSync(join(f.root, '.github/workflows/upstream.yml'), 'utf8'), 'name: fork-owned automation\n')
  assert.equal(f.git('ls-files', 'master-only.js', '.github/workflows/new-upstream.yml'), '')
  assert.equal(f.git('diff', '--name-only'), '')
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
})

test('upgrades even when the new tag is already an ancestor of the restored fork', t => {
  const f = fixture(t, { releaseAlreadyAncestor: true })
  assert.doesNotThrow(() => f.git('merge-base', '--is-ancestor', NEXT_TAG, 'HEAD'))
  const result = prepareRelease(f.root, { upstream: f.upstream })
  assert.equal(result.changed, true)
  assert.equal(result.tag, NEXT_TAG)
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version, '0.2.2-rc.4')
  assert.match(readFileSync(join(f.root, 'custom.css'), 'utf8'), /--accent: green/)
  assert.match(readFileSync(join(f.root, 'custom.css'), 'utf8'), /padding: 12px/)
  assert.equal(f.git('ls-files', 'master-only.js'), '')
})

test('stops on a real same-line customization conflict without updating the baseline or creating a commit', t => {
  const f = fixture(t)
  f.release('0.2.2-rc.4', { conflict: true })
  assert.throws(() => prepareRelease(f.root, { upstream: f.upstream }), /could not be merged; no commit or push/)
  assert.equal(f.git('diff', '--name-only', '--diff-filter=U'), 'custom.css')
  assert.equal(preparedDeclaration(f).upstreamTag, OLD_TAG)
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
})

test('supports annotated official tags while recording their commit and tree identities', t => {
  const f = fixture(t)
  const next = f.release('0.2.2-rc.4', { annotated: true })
  const result = prepareRelease(f.root, { upstream: f.upstream })
  assert.equal(result.upstreamCommit, next.commit)
  assert.equal(preparedDeclaration(f).upstreamTree, next.tree)
})

test('refuses to touch a dirty worktree', t => {
  const f = fixture(t)
  f.release()
  f.write('api.js', 'uncommitted local edit\n')
  assert.throws(() => prepareRelease(f.root, { upstream: f.upstream }), /requires a clean, disposable Git checkout/)
  assert.equal(readFileSync(join(f.root, 'api.js'), 'utf8'), 'uncommitted local edit\n')
  assert.equal(preparedDeclaration(f).upstreamTag, OLD_TAG)
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
})

test('rejects a tag whose product version does not match its release label', t => {
  const f = fixture(t)
  f.release('0.2.2-rc.4', { manifestVersion: '0.2.2-rc.3' })
  assert.throws(() => prepareRelease(f.root, { upstream: f.upstream }), /does not match dsh-v0\.2\.2-rc\.4/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.head)
})
