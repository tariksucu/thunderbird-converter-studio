#!/usr/bin/env bash
# webext-linter.sh [args…]: runs Thunderbird's own add-on linter (github.com/thunderbird/webext-linter,
# the automated review addons.thunderbird.net's reviewers start from) on the built XPI in dist/
# (run `node tools/build.mjs` first). The linter is fetched once, pinned to one commit, into
# $WEBEXT_LINTER_DIR (default ~/.cache/webext-linter); its work folder lands in dist/.
# Exit code 1 means it found an error; its "manual review" items are for a person.
set -euo pipefail
COMMIT=9c907b702cc09b731df369cd3c50af4dfb0835a7
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$HERE/src/manifest.json').version")"
XPI="$HERE/dist/converter-studio-$VERSION.xpi"
[ -f "$XPI" ] || { echo "no $XPI: run node tools/build.mjs first" >&2; exit 2; }
L="${WEBEXT_LINTER_DIR:-$HOME/.cache/webext-linter}"
if [ ! -f "$L/.commit-$COMMIT" ]; then
  rm -rf "$L"
  mkdir -p "$L"
  curl -fsSL "https://codeload.github.com/thunderbird/webext-linter/tar.gz/$COMMIT" | tar -xz -C "$L" --strip-components=1
  (cd "$L" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
  touch "$L/.commit-$COMMIT"
fi
# The linter keeps its downloads (schemas, library hashes) beside where it runs.
cd "$L"
node verify.js "$XPI" "$@"
