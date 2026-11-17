#!/bin/bash
# Record macOS host resources and command usage without capturing command output or environment variables.
set -euo pipefail

usage() {
  echo 'Usage: macos-package-diagnostics.sh snapshot FILE | run FILE COMMAND [ARG...]' >&2
  exit 64
}

[[ $# -ge 2 ]] || usage
mode="$1"
report="$2"
shift 2
mkdir -p "$(dirname "$report")"

case "$mode" in
  snapshot)
    [[ $# -eq 0 ]] || usage
    {
      date -u
      sw_vers
      sysctl hw.ncpu hw.memsize vm.swapusage
      top -l 2 -s 1 -n 0
      vm_stat
      df -k .
      iostat -c 2 -w 1
    } > "$report"
    ;;
  run)
    [[ $# -gt 0 ]] || usage
    # FD 3 preserves the command's stderr; only time's resource report enters the artifact.
    exec /usr/bin/time -l /bin/bash -c 'exec "$@" 2>&3' -- "$@" 3>&2 2> "$report"
    ;;
  *) usage ;;
esac
