#!/bin/sh
# Run a harness script on the pinned Executor copy: no network, read-only mounts, resource limits.
# Usage: proof/run.sh <name> <node|bun> <script> [args...]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
name=$1 runtime=$2
shift 2
case "$runtime" in
  node) image=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c ;;
  bun) image=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d ;;
  *) echo "runtime must be node or bun" >&2; exit 2 ;;
esac
mkdir -p "$here/out"
exec docker run --rm --name "executor-proof-$name" --network none \
  --cpus "${CPUS:-2}" --memory "${MEMORY:-3g}" --pids-limit 1024 \
  -v "${WORK:-$root/work/upstream}:/w:ro" \
  -v "$here/harness:/w/packages/apps/harness:ro" \
  -v "$here/data:/data:ro" \
  -v "$here/ref:/ref:ro" \
  -v "$here/out:/out" \
  -w /w/packages/apps "$image" "$runtime" "$@"
