/** Exercise release pinning against real, private Git repositories. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { verifyReleaseBase } from './verify-release-base.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-pin-'))
  t.after(() => {
    assert.ok(basename(resolve(root)).startsWith('dsh-release-pin-'))
    rmSync(root, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Fork test')
  git('config', 'user.email', 'fork-test@example.invalid')
  git('config', 'core.hooksPath', '/dev/null')
  const write = (path, text) => writeFileSync(join(root, path), text)
  write('package.json', JSON.stringify({ version: '0.2.2-rc.3' }))
  write('connection.js', 'export const authenticatedUrl = true\n')
  write('custom.css', 'body {}\n')
  git('add', 'package.json', 'connection.js', 'custom.css')
  git('commit', '-m', 'official release')
  git('tag', 'dsh-v0.2.2-rc.3')
  mkdirSync(join(root, '.github'))
  const config = { upstreamTag: 'dsh-v0.2.2-rc.3', upstreamTree: git('rev-parse', 'HEAD^{tree}'), customPaths: ['custom.css'] }
  const writeConfig = () => write('.github/fork-release.json', JSON.stringify(config))
  writeConfig()
  return { root, git, write, config, writeConfig }
}

test('accepts declared customizations over the pinned official release', t => {
  const f = fixture(t)
  f.write('custom.css', 'body { overflow: clip }\n')
  assert.ok(verifyReleaseBase(f.root).changedPaths.includes('custom.css'))
})

test('rejects development API changes even when the version remains rc.3', t => {
  const f = fixture(t)
  f.write('connection.js', 'export const authenticatedUrl = false\n')
  assert.throws(() => verifyReleaseBase(f.root), /Undeclared changes.*connection\.js/)
})

test('rejects untracked product code', t => {
  const f = fixture(t)
  f.write('development.js', 'export const changedApi = true\n')
  assert.throws(() => verifyReleaseBase(f.root), /Undeclared changes.*development\.js/)
})

test('rejects renaming an upstream API into a declared customization path', t => {
  const f = fixture(t)
  f.git('mv', '-f', 'connection.js', 'custom.css')
  assert.throws(() => verifyReleaseBase(f.root), /Undeclared changes.*connection\.js/)
})

test('rejects hiding an upstream API deletion inside the workflow directory', t => {
  const f = fixture(t)
  f.git('mv', 'connection.js', '.github/connection.js')
  assert.throws(() => verifyReleaseBase(f.root), /Undeclared changes.*connection\.js/)
})

test('rejects a release tag that has moved', t => {
  const f = fixture(t)
  f.write('connection.js', 'export const authenticatedUrl = false\n')
  f.git('add', 'connection.js')
  f.git('commit', '-m', 'development changes')
  f.git('tag', '-f', f.config.upstreamTag)
  assert.throws(() => verifyReleaseBase(f.root), /does not match the pinned upstream tree/)
})

test('rejects a version label that differs from the pinned release', t => {
  const f = fixture(t)
  f.write('package.json', JSON.stringify({ version: '0.2.2-rc.2' }))
  assert.throws(() => verifyReleaseBase(f.root), /does not match dsh-v0.2.2-rc.3/)
})

test('rejects malformed release declarations', t => {
  const f = fixture(t)
  f.config.customPaths = null
  f.writeConfig()
  assert.throws(() => verifyReleaseBase(f.root), /Invalid .github\/fork-release.json/)
})
