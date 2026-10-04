#!/usr/bin/env bash
# Stages the Ycash contribution to the x402 Foundation repository in a LOCAL clone of it.
# Nothing is pushed, published or opened: the owner does that by hand (docs/upstream.md).
#
#   tools/upstream/stage.sh [--part spec|impl|all] [--check] <x402-fork>
#
#   <x402-fork>   a local clone of x402-foundation/x402 (never the read-only reference tree)
#   --part spec   PR 1: the two binding specs and the Ycash entry in scheme_exact.md
#   --part impl   PR 2: typescript/packages/mechanisms/ycash and the e2e / examples / workflow /
#                 changeset edits (tools/upstream/fork.patch)
#   --part all    both (default)
#   --check       then install with the fork's pnpm and run the upstream checks on the package
#
# What it does, so a refresh after a change in this repository is one command:
#   specs/*.md                  → specs/schemes/{exact,batch-settlement}/…   (transform.mjs spec)
#   packages/ycash/src          → typescript/packages/mechanisms/ycash/src   (transform.mjs code)
#   packages/ycash/test/unit    → …/test/unit (flow/ goes to test/integrations/)
#   packages/ycash/test/devnet  → …/test/integrations/*.devnet.test.ts (not the x4m measurement)
#   vectors/**/*.json           → …/test/vectors/
#   tools/upstream/overlay/package → package.json, tsup, eslint, prettier, vitest configs, README
#   tools/upstream/fork.patch   → e2e, examples, workflows, changeset, README rows (git apply)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
part=all
check=0
fork=""
while [ $# -gt 0 ]; do
  case "$1" in
    --part) part="$2"; shift 2 ;;
    --check) check=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) fork="$1"; shift ;;
  esac
done
[ -n "$fork" ] || { echo "usage: stage.sh [--part spec|impl|all] [--check] <x402-fork>" >&2; exit 2; }
case "$part" in spec|impl|all) ;; *) echo "--part must be spec, impl or all" >&2; exit 2 ;; esac
fork="$(cd "$fork" && pwd)"

# Guardrails: a clone of x402, not the read-only reference, and not this repository.
[ -d "$fork/typescript/packages/mechanisms/cardano" ] && [ -f "$fork/specs/schemes/exact/scheme_exact.md" ] \
  || { echo "stage.sh: $fork is not an x402 checkout" >&2; exit 2; }
case "$fork" in */wt/x402-upstream|*/wt/x402-upstream/) echo "stage.sh: refusing to write into the read-only reference $fork; clone it first" >&2; exit 2 ;; esac
if git -C "$fork" remote -v | grep -q 'push'; then
  echo "stage.sh: note: $fork has a push remote; nothing here pushes, and the owner decides when to" >&2
fi

node_bin() { command -v node >/dev/null || { echo "stage.sh: node is required" >&2; exit 2; }; node "$@"; }

stage_spec() {
  local ex="$fork/specs/schemes/exact/scheme_exact_ycash.md"
  local bs="$fork/specs/schemes/batch-settlement/scheme_batch_settlement_ycash.md"
  cp "$repo/specs/scheme_exact_ycash.md" "$ex"
  cp "$repo/specs/scheme_batch_settlement_ycash.md" "$bs"
  node_bin "$here/transform.mjs" spec "$ex" exact
  node_bin "$here/transform.mjs" spec "$bs" batch
  # scheme_exact.md: the Ycash entry in its per-network list and validation section (idempotent)
  local ov="$fork/specs/schemes/exact/scheme_exact.md"
  if ! grep -q 'scheme_exact_ycash.md' "$ov"; then
    node_bin - "$ov" "$here/overlay/scheme_exact_ycash_section.md" <<'EOF'
const fs = require("node:fs");
const [file, sectionFile] = process.argv.slice(2);
let s = fs.readFileSync(file, "utf8");
const section = fs.readFileSync(sectionFile, "utf8").trimEnd();
const anchor = "\nNetwork-specific rules are in per-network documents:";
if (!s.includes(anchor)) throw new Error("scheme_exact.md: per-network list not found");
s = s.replace(anchor, `\n${section}\n${anchor}`);
s = s.replace(/`scheme_exact_hedera\.md` \(Hedera\)\./, "`scheme_exact_hedera.md` (Hedera), `scheme_exact_ycash.md` (Ycash).");
if (!s.includes("`scheme_exact_ycash.md` (Ycash)")) throw new Error("scheme_exact.md: list entry not added");
fs.writeFileSync(file, s);
EOF
  fi
  echo "staged: specs (exact, batch-settlement, scheme_exact.md entry)"
}

stage_impl() {
  local pkg="$fork/typescript/packages/mechanisms/ycash"
  local src="$repo/packages/ycash"
  rm -rf "$pkg"
  mkdir -p "$pkg/test/integrations" "$pkg/test/vectors"
  cp -R "$src/src" "$pkg/src"
  mv "$pkg/src/batch" "$pkg/src/batch-settlement"
  cp -R "$src/test/unit" "$pkg/test/unit"
  mv "$pkg/test/unit/batch" "$pkg/test/unit/batch-settlement"
  # in-process flows → integration tests, one directory up
  for f in "$pkg/test/unit/flow/"*.test.ts; do
    sed -e 's#"\.\./\.\./\.\./src/#"../../src/#g' -e 's#"\.\./\([a-z]*\)/#"../unit/\1/#g' -e 's#tools/upstream/stage.sh moves it to test/integrations/#this file#' \
      "$f" > "$pkg/test/integrations/$(basename "$f")"
  done
  rm -rf "$pkg/test/unit/flow"
  # devnet suites → integration tests that skip without X402_DEVNET_JSON
  for f in "$src/test/devnet/"*.ts; do
    case "$(basename "$f")" in x4m*) continue ;; esac
    cp "$f" "$pkg/test/integrations/"
  done
  # the stratum-pool case drives this repository's devnet tooling: skipped unless it is there
  local op3="$pkg/test/integrations/exact_yec.devnet.test.ts"
  if grep -q '  it("OP-3:' "$op3"; then
    sed -i.bak 's/  it("OP-3:/  it.skipIf(!process.env.YELLOWBACK_WORKSPACE)("OP-3:/' "$op3" && rm "$op3.bak"
  fi
  (cd "$repo/vectors" && find . -name '*.json' -print0 | while IFS= read -r -d '' v; do
    mkdir -p "$pkg/test/vectors/$(dirname "$v")"; cp "$v" "$pkg/test/vectors/$v"; done)
  node_bin "$here/transform.mjs" code "$pkg/src"
  node_bin "$here/transform.mjs" code "$pkg/test"
  # overlay: package metadata and configs in upstream's form (dotfiles included)
  (cd "$here/overlay/package" && tar cf - .) | (cd "$pkg" && tar xf -)
  # fork-wide edits (e2e, examples, workflows, changeset, READMEs), once
  if [ ! -s "$here/fork.patch" ]; then
    echo "stage.sh: warning: no fork.patch; e2e, examples and workflow edits not staged" >&2
  elif git -C "$fork" apply --reverse --check "$here/fork.patch" 2>/dev/null; then
    echo "staged: fork.patch already applied"
  else
    git -C "$fork" apply --whitespace=nowarn "$here/fork.patch"
    echo "staged: fork.patch applied"
  fi
  echo "staged: typescript/packages/mechanisms/ycash"
}

run_checks() {
  local ts="$fork/typescript"
  local pnpm="${PNPM:-pnpm}"
  command -v "$pnpm" >/dev/null || { echo "stage.sh: --check needs pnpm 11 (set PNPM=/path/to/pnpm; see docs/upstream.md)" >&2; exit 2; }
  local results=()
  step() {
    local name="$1"; shift
    if (cd "$ts" && "$@") >"$fork/../check-$name.log" 2>&1; then results+=("PASS  $name"); else results+=("FAIL  $name  (log: $(dirname "$fork")/check-$name.log)"); fi
  }
  # PNPM_INSTALL_FLAGS: e.g. --config.minimum-release-age-strict=false where the registry's
  # abbreviated metadata lacks "time" (ERR_PNPM_MISSING_TIME; see docs/upstream.md)
  # shellcheck disable=SC2086
  step install "$pnpm" install --filter "@x402/ycash..." --filter "@x402/core" ${PNPM_INSTALL_FLAGS:-}
  # twice: prettier 3.5 moves some trailing comments only on its second pass
  step format "$pnpm" --filter @x402/ycash format
  step format-2 "$pnpm" --filter @x402/ycash format
  step build "$pnpm" --filter @x402/core --filter @x402/ycash build
  step typecheck "$pnpm" --filter @x402/ycash exec tsc --noEmit -p tsconfig.json
  step format-check "$pnpm" --filter @x402/ycash format:check
  step lint-check "$pnpm" --filter @x402/ycash lint:check
  step test "$pnpm" --filter @x402/ycash test
  step test-integration "$pnpm" --filter @x402/ycash test:integration
  step verify-exports "$pnpm" verify:exports
  printf '%s\n' "${results[@]}"
}

case "$part" in
  spec) stage_spec ;;
  impl) stage_impl ;;
  all) stage_spec; stage_impl ;;
esac
[ "$check" = 1 ] && run_checks
exit 0
