#!/bin/bash
# Run from the repo root after staging has exported the trusted x64 generation as FORK_CUA_BUNDLE.
set -euo pipefail

die() { printf 'CUA DMG verification failed: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die 'pass exactly one DMG path'
[[ $1 == *.dmg && -f $1 ]] || die "expected a DMG file: $1"
[[ ${FORK_CUA_BUNDLE:-} =~ ^[0-9a-f]{64}$ ]] || die 'FORK_CUA_BUNDLE must contain the trusted x64 SHA-256 digest'
case $1 in /*) dmg=$1 ;; *) dmg=$PWD/$1 ;; esac

temp_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
mountpoint=$(mktemp -d "$temp_root/fork-cua-dmg.XXXXXXXX")
cleanup() {
  local status=$?
  # A signal can arrive after attach mounts the volume but before it returns.
  if [[ -d $mountpoint && $(stat -f %d "$mountpoint") != "$(stat -f %d "$temp_root")" ]]; then
    /usr/bin/hdiutil detach "$mountpoint" || /usr/bin/hdiutil detach -force "$mountpoint" || exit 1
  fi
  if [[ -d $mountpoint ]]; then rmdir "$mountpoint" || exit 1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$dmg" </dev/null

node --input-type=module - "$mountpoint" <<'JS'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { readCuaApplication } from './scripts/cua-helper/payload.ts'

const directory = join(process.argv[2], 'DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules',
  '@deepseek-ai/dsh-experimental-cua-macos/native/bin/darwin-x64')
if (realpathSync(directory) !== directory) throw new Error(`CUA payload path traverses a symlink: ${directory}`)
// The staged digest covers the signed x86_64 binary, its bundle resources, executable bits and ticket.
const { bundle } = readCuaApplication(directory)
if (bundle !== process.env.FORK_CUA_BUNDLE) throw new Error(`Unexpected CUA generation ${bundle}, expected ${process.env.FORK_CUA_BUNDLE}`)
JS
printf 'Verified x86_64 CUA generation %s in %s\n' "$FORK_CUA_BUNDLE" "$dmg"
