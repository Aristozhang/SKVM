#!/usr/bin/env bash
# Build skvm binaries for all four release targets and produce tarballs ready
# for GitHub Releases. Tarballs include the compiled binary, skills/, README,
# and LICENSE so a `curl | sh` install leaves a usable directory.
#
# Called locally by `bun run build:all` and from .github/workflows/release.yml.
#
# Output layout:
#   dist/
#     skvm-v<version>-<target>/bin/skvm
#     skvm-v<version>-<target>/skills/...
#     skvm-v<version>-<target>/README.md
#     skvm-v<version>-<target>/LICENSE
#     skvm-v<version>-<target>.tar.gz
#     skvm-v<version>-<target>.tar.gz.sha256

set -euo pipefail

cd "$(dirname "$0")/.."
repo_root="$(pwd)"

version=$(node -e "console.log(require('./package.json').version)")
tag="v${version}"

targets=(
  "darwin-arm64"
  "darwin-x64"
  "linux-x64"
  "linux-arm64"
  "windows-x64"
)

# Allow BUILD_TARGETS=darwin-arm64,linux-x64 to override (useful for fast local smoke tests).
if [ -n "${BUILD_TARGETS:-}" ]; then
  IFS=',' read -r -a targets <<< "$BUILD_TARGETS"
fi

rm -rf dist
mkdir -p dist

for target in "${targets[@]}"; do
  echo "=== building $target ==="
  stage="dist/skvm-${tag}-${target}"
  mkdir -p "${stage}/bin"

  bun build src/index.ts \
    --compile \
    --minify \
    --target="bun-${target}" \
    --outfile "${stage}/bin/skvm"

  # Ship only the two agent-facing skills; hard-task-generator is
  # task-authoring tooling and not relevant to skvm CLI users.
  mkdir -p "${stage}/skills"
  cp -R skills/skvm-jit "${stage}/skills/"
  cp -R skills/skvm-general "${stage}/skills/"
  cp README.md "${stage}/README.md"
  cp LICENSE "${stage}/LICENSE"
  # Bun compiled binaries need package.json at runtime (version metadata).
  # Copy to both the tarball root and bin/ â€?Bun resolves from the binary's dir.
  cp package.json "${stage}/package.json"
  cp package.json "${stage}/bin/package.json"

  # Tarball layout: bin/skvm, skills/, README.md, LICENSE at top level
  # (no wrapper dir), so `tar -xzf ... -C $PREFIX` lays out directly under $PREFIX.
  # Both install.sh and postinstall.js depend on this flat layout.
  tar -czf "dist/skvm-${tag}-${target}.tar.gz" -C "$stage" .

  # Checksum (works on both macOS and Linux)
  if command -v sha256sum >/dev/null 2>&1; then
    (cd dist && sha256sum "skvm-${tag}-${target}.tar.gz" > "skvm-${tag}-${target}.tar.gz.sha256")
  else
    (cd dist && shasum -a 256 "skvm-${tag}-${target}.tar.gz" > "skvm-${tag}-${target}.tar.gz.sha256")
  fi
done

echo ""
echo "=== build artifacts ==="
ls -lh dist/*.tar.gz* 2>/dev/null || true
