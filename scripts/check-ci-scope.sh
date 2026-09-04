#!/usr/bin/env bash
# Prove the CI scope gate, which decides whether the end-to-end suite runs.
#
# A gate that wrongly says "heavy" costs the end-to-end suite. A gate that wrongly says
# "light" costs the coverage silently, and that is the failure worth a test:
# the run stays green either way, so nothing else will tell you.
#
# The gate itself lives in .github/workflows/ci.yml — one source, read out of
# the workflow here rather than copied, so this cannot drift from what runs.
# Usage: bash scripts/check-ci-scope.sh
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
node -e '
  const { readFileSync, writeFileSync } = require("node:fs")
  const yaml = readFileSync(".github/workflows/ci.yml", "utf8")
  // The block under `run: |`, dedented — no YAML parser needed for one step.
  const start = yaml.indexOf("Whether this diff can change behaviour")
  const body = yaml.slice(yaml.indexOf("run: |", start) + "run: |\n".length)
  const lines = []
  for (const line of body.split("\n")) {
    if (line.trim() !== "" && !line.startsWith("          ")) break
    lines.push(line.slice(10))
  }
  writeFileSync(process.argv[1], lines.join("\n"))
' "$work/scope.sh"

mkdir -p "$work/bin"
cat > "$work/bin/git" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *--name-only*) printf '%s\n' $FAKE_FILES ;;
  *-U0*) [ -n "${FAKE_MANIFEST_EXTRA:-}" ] && echo '+  "dependencies": {},'; exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$work/bin/git"

failed=0
expect() { # expect <heavy> <description> <files> [manifest-changed-beyond-version]
  local want="$1" what="$2" files="$3" extra="${4:-}"
  : > "$work/out"
  FAKE_FILES="$files" FAKE_MANIFEST_EXTRA="$extra" BASE=base GITHUB_OUTPUT="$work/out" \
    PATH="$work/bin:$PATH" bash "$work/scope.sh" > "$work/msg" 2>&1 || true
  local got; got="$(sed -n 's/^heavy=//p' "$work/out")"
  if [ "$got" = "$want" ]; then
    printf '  ok    heavy=%-5s %s\n' "$got" "$what"
  else
    printf '  FAIL  heavy=%-5s (wanted %s)  %s\n        %s\n' "$got" "$want" "$what" "$(cat "$work/msg")"
    failed=1
  fi
}

echo "CI scope gate:"
expect false 'prose, pictures, and the site'        'README.md CONTEXT.md site/assets/og.png docs/adr/0001.md packages/cli/README.md'
expect false 'the Version Packages commit'          '.changeset/x.md packages/cli/CHANGELOG.md packages/cli/package.json'
expect true  'a source file'                        'packages/bundle/src/keys.ts'
expect true  'prose alongside a source file'        'README.md packages/bundle/src/keys.ts'
expect true  'a test'                               'packages/bundle/tests/keys.spec.ts'
expect true  'an end-to-end test'                   'e2e/pty.e2e.ts'
expect true  'a workflow'                           '.github/workflows/ci.yml'
expect true  'an agent preset'                      'packages/bundle/agent-presets/code-cli/preset.yml'
expect true  'a lockfile'                           'pnpm-lock.yaml'
expect true  'a manifest changed beyond its version' 'packages/cli/package.json' yes

[ "$failed" -eq 0 ] || { echo "the gate does not decide what it is meant to"; exit 1; }
echo "the gate decides what it is meant to"
