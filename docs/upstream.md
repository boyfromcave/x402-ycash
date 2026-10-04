# The x402 Foundation contribution

x402 adds a chain in three steps (`CONTRIBUTING.md`, "Adding a New Chain Family" in
`x402-foundation/x402`): PR 1 is the spec only, PR 2 is a reference implementation in one SDK with
tests, e2e, examples, a changeset and a publishing workflow, and PR 3 adds other SDKs. This
repository is where the Ycash bindings are built and proved. The upstream contribution is
**generated** from it, so it can be refreshed after every change here.

**Status (2026-10-04, chunk `final2`): staged locally, not published.** No issue, PR or package has been opened or
pushed. The owner decides when (plan X-9). The staged branches, the upstream checks that pass and
fail, the drafted PR bodies and the owner's open decisions are in
`wt/scratch/x402-upstream-prep/PUBLISHING.md` in the Yellowback workspace.

## Where it lives

- **The staged fork:** `wt/scratch/x402-upstream-prep/x402-fork`, a local clone of `x402-foundation/x402`
  at `751590a2` with no remote. Branch `ycash-spec` holds PR 1 (one commit), and `ycash-binding`
  holds PR 2 on top of it. The fork stays in scratch and is never committed here.
- **The generator, here:** `tools/upstream/`.

| File | Role |
|---|---|
| `stage.sh` | Copies and transforms this repository into a fork; `--check` then runs the upstream checks |
| `transform.mjs` | Rewrites the copied TypeScript and specs into upstream's layout and style |
| `overlay/package/` | The package files upstream needs: `package.json` (`@x402/ycash`, `workspace:~` core, the export map), tsup, eslint, prettier, vitest configs, `README.md` |
| `overlay/scheme_exact_ycash_section.md` | The Ycash section added to upstream's `scheme_exact.md` |
| `fork.patch` | Edits outside the package: e2e catalog and registrations, `all_networks` examples, publish workflow, changeset, labeler, README rows |

## What `stage.sh` does

```
specs/scheme_exact_ycash.md            → specs/schemes/exact/scheme_exact_ycash.md
specs/scheme_batch_settlement_ycash.md → specs/schemes/batch-settlement/scheme_batch_settlement_ycash.md
packages/ycash/src                     → typescript/packages/mechanisms/ycash/src   (batch/ → batch-settlement/)
packages/ycash/proto                   → typescript/packages/mechanisms/ycash/proto (read by src/lwd at run time)
packages/ycash/test/unit               → …/test/unit             (unit/flow/*.test.ts → test/integrations/)
packages/ycash/test/devnet             → …/test/integrations/*.devnet.test.ts   (not the x4m measurement)
vectors/**/*.json                      → …/test/vectors/
tools/upstream/overlay/package/        → package metadata and configs
tools/upstream/fork.patch              → git apply (skipped when already applied)
```

`transform.mjs` makes these rewrites:

- **Imports.** Relative imports lose `.js`, since upstream resolves with `"bundler"`. `batch` becomes
  `batch-settlement`, the evm and svm directory name.
- **Paths.** Vector paths and spec paths become the upstream ones.
- **Comments and test titles.** References to this repository's plan are dropped: sections, phases,
  decisions and findings (`plan §5.7`, `X4a`, `X-F14`). Node-behaviour ids stay, because they are
  the specs' Appendix A rows. Node checkouts are named by release: `ycash-dd/src/…` becomes
  `Ycash 4.5.0 src/…`, and `ycash6/src/…` becomes `Ycash 6.21.0 src/…`. Code and data are not
  touched.
- **Specs.** Exact, asserted replacements: relative links, the plan references, and Appendix A's
  preamble, which now cites the public node trees (`boyfromcave/ycash-dd@795f29b1e` and
  `boyfromcave/ycash6@e6c49d743`, on `ycashfoundation/ycash` `v4.5.0` and `miodragpop/ycash`).

If a spec sentence it expects has changed, the run fails instead of staging half a rewrite. It
also prints every line that still names the plan or a node checkout.

Formatting is upstream's. `--check` runs prettier twice (prettier 3.5 moves some trailing comments
only on its second pass), so this repository keeps its own ~160-column style.

## Refresh after a change here

```bash
# once: a clone of upstream (never the read-only reference wt/x402-upstream) and its toolchain
git clone ../x402-upstream ../scratch/x402-upstream-prep/x402-fork          # from wt/x402-<name>
npm install --prefix ../scratch/x402-upstream-prep/toolchain pnpm@11.1.1    # local pnpm, no global install
# each time: node 24 (pnpm 11 needs node:sqlite), the local pnpm, then stage and check
source ~/.nvm/nvm.sh && nvm use 24
export PATH=$PWD/../scratch/x402-upstream-prep/toolchain/node_modules/.bin:$PATH
PNPM_INSTALL_FLAGS=--config.minimum-release-age-strict=false tools/upstream/stage.sh --check ../scratch/x402-upstream-prep/x402-fork
```

`--part spec` stages PR 1 alone and `--part impl` stages PR 2 alone. `stage.sh` refuses to write
into `wt/x402-upstream`. It never commits, pushes or publishes; committing in the fork and
everything after it is in `PUBLISHING.md`.

`PNPM_INSTALL_FLAGS`: pnpm 11's strict `minimumReleaseAge` check fails on this machine with
`ERR_PNPM_MISSING_TIME`, because the registry's abbreviated metadata lacks a `time` field. The
non-strict flag skips that check only for the packages concerned.

A fresh clone staged with `--check` is identical to the committed `ycash-binding`, except for
lockfile ordering. That was checked on 2026-10-03.

When `fork.patch` no longer applies (upstream moved): stage onto the older base, rebase the fork
branch onto the new upstream, resolve the conflicts there, and regenerate the patch:
`git -C <fork> diff main ycash-binding -- .github e2e examples typescript/.changeset typescript/README.md typescript/package.json > tools/upstream/fork.patch`.

## Upstream checks (2026-10-04, chunk `final2`)

Restaged from `x402/final2` (`ec52b4e`, on `main` at `d4db4c3`) into the fork: `ycash-spec`
at `0c6053b3` (now with the `sapling` method), `ycash-binding` at `dd720929` on it (now
with the shielded `sapling` facilitator, server half, `ShieldedMethodRouter`, and the
`builder.ts`/`light.ts` client side). Node 24.13.0, pnpm 11.1.1. The ten checks of
`stage.sh --check`:

| Check | Result |
|---|---|
| `install` (pnpm, with `minimum-release-age-strict=false`) | pass |
| `format`, `format-2` (prettier, twice) | pass |
| `build` (tsup ESM/CJS/d.ts) | pass |
| `typecheck` (`tsc --noEmit`) | pass |
| `format-check` | pass |
| `lint-check` (upstream's eslint config, JSDoc and member-ordering rules included) | pass: 0 errors, 0 warnings |
| `test` (702 tests in 44 files; coverage 94.3% lines, 88.9% branches, 95.3% functions; thresholds 80%) | pass |
| `test-integration` (5 in-process flow tests; the 6 devnet suites, 53 tests, skip without `X402_DEVNET_JSON`) | pass |
| `verify-exports` | pass |
| `test:integration` on a ycash-dd (4.5.0) regtest devnet | 57 pass, 1 skipped (the stratum-pool case needs this workspace), 158 s (seed 397) |
| `test:integration` on a ycash6 (6.21.0) regtest devnet | 57 pass, 1 skipped, 274 s (seed 399) |

The first staged devnet runs (seeds 391 and 393) were not green. On 6.21.0, `exact_yec`'s
YED-bearing-input test failed with `mintpol-no-price`: upstream's alphabetical file order runs it
after `channel_yec`, whose stock-mined blocks empty the price window; its mint now retries on a
pool as `yed`'s `ensureYed` does (`ec52b4e`). On 4.5.0, three `channel_yec` and three `exact_yec`
tests timed out waiting for tips to agree: from 10:55:36 something outside the run mined on pools
2, 3 and 4 round-robin about once a second (the cadence of the devnet CLI's own `up`/`mine`),
racing the tests' blocks into equal-height forks (two blocks at height 367, 7 ms apart, on node 2
and node 1). No suite mines that way; the cause was not found, and the same suites passed on a
fresh devnet at seed 397. Treat it as interference, like the seed-371 collision recorded in
`docs/regression.md`.

Three staging fixes this round, all in `tools/upstream/`: the overlay lists `@noble/ciphers`
(`sapling`'s note decryption; without it build and typecheck fail), `transform.mjs` also rewrites
vector paths in template literals (`decrypt.test.ts` loads `vectors/sapling/${name}`), and the
spec transform matches the new `sapling` text (the old `(sapling, plan X4b)` anchors are gone; it
drops the plan's finding ids and its N rows, which have no Appendix A row, and names the builder
generically). The staged package README describes `sapling` and names the Rust light client in
`boyfromcave/x402-ycash` as the reference builder; comments that cite `light/schema.json` become
`x402-ycash light/schema.json`. The Rust light client (`light/`) is not staged: upstream SDKs are
per language, and it builds only against the Ycash-patched librustzcash fork (owner decision 11 in
`PUBLISHING.md`).

The staged package carries no plan reference: a grep of `src/`, `test/` and `README.md` for
`plan `, `X-F`, phase ids (`X4b`), the N rows and `docs/plans` finds none, and the remaining ids
(`R-n`, `S-n`, `Y-n`, `Z-n`, `G-n`) are rows of the specs' Appendix A or Yellowback rule ids cited
with the node file (`XFER-1`, `MINT-3`, `IN-3`, `ACT-4`). Two leftovers the transform prints are
code, not prose: a devnet test that picks the node checkout to drive, and a vector check of the
`line` field.

The package's dependencies beyond `@x402/core`: `@noble/secp256k1` 3.x, `@noble/hashes` 2.x,
`@noble/curves` 2.x (the offline Sapling issuer and trial decryption; upstream's lockfile has 1.x
for `extensions`, so 2.x is a second major there), `@noble/ciphers` 1.3 (already in upstream's
lockfile), `@grpc/grpc-js` and `@grpc/proto-loader` (the lightwalletd adapter, `src/lwd`).
`stage.sh` copies `proto/` into the package (and `files` ships it), and the tsup config shims
`import.meta.url` in the CJS build, which `src/lwd` uses to find the protos.

## Differences from upstream conventions, kept on purpose

- **Class names.** Ours are `ExactYcashScheme`, `ExactYcashServerScheme`, `ExactYcashFacilitatorScheme`
  and `BatchYcashScheme`. Cardano names all three of its classes `ExactCardanoScheme`, and EVM uses
  `BatchSettlementEvmScheme`. The subpath exports follow upstream; renaming the classes is a
  reviewer's call.
- **e2e scope.** e2e covers `exact` only. Upstream's `batch-settlement` e2e is a multi-phase
  orchestration built for EVM and SVM, so channels are covered by the package's integration and
  devnet suites.
