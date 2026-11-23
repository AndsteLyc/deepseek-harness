/** Stage the official Intel helper before Desktop packs the fork's local workspace packages. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyMacOSNotarizedApplication } from '../../apps/desktop/scripts/verify-macos-signature.mjs'
import { readCuaApplication } from '../../scripts/cua-helper/payload.ts'

const provider = resolve('packages/experimental/cua-macos')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const { name, version } = readJson(join(provider, 'package.json'))
assert.equal(name, '@deepseek-ai/dsh-cua-macos')
assert.equal(version, readJson('package.json').version, 'CUA provider must match the Desktop release')
const temp = mkdtempSync(join(tmpdir(), 'fork-cua-x64-'))
try {
  const [packed] = JSON.parse(execFileSync('npm', [
    'pack', `${name}@${version}`, '--registry=https://registry.npmjs.org', '--ignore-scripts', '--json',
  ], { cwd: temp, encoding: 'utf8' }))
  assert.equal(packed.name, name)
  assert.equal(packed.version, version)
  const relative = 'native/bin/darwin-x64'
  execFileSync('tar', ['-xzf', packed.filename, `package/${relative}`], { cwd: temp })
  const source = join(temp, 'package', relative)
  const { application, bundle } = readCuaApplication(source)
  execFileSync('lipo', [join(application, 'Contents/MacOS/dsh-cua-native'), '-verify_arch', 'x86_64'])
  verifyMacOSNotarizedApplication(application, {
    signingIdentity: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd (NAN929V4UM)', teamId: 'NAN929V4UM',
  })
  const bin = join(provider, 'native/bin')
  mkdirSync(bin)
  cpSync(source, join(bin, 'darwin-x64'), { recursive: true })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `bundle=${bundle}\n`)
  console.log(`Staged ${name}@${version} Intel helper ${bundle}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
