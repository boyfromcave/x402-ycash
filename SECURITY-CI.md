# Security CI

x402-ycash signs and verifies payments: the TypeScript mechanism and facilitator, the Python bindings, the
Rust light client and the Falcon C the Python signer compiles. Three workflows check it, beside `ci.yml`
(lint, typecheck, unit tests, the light client, the Python bindings, the facilitator image). The pattern is
the same in every Yellowback repository. None of them opens an issue; only Semgrep and Dependabot open PRs,
and those are capped (below).

| Leg | Workflow / job | Runs on | Gate | Results |
|---|---|---|---|---|
| Semgrep | `semgrep.yml` | PR (diff-aware), push, nightly 02:17 UTC | a PR fails on a new **critical** finding | run summary, code scanning (`semgrep`), at most four rolling PRs `semgrep/<bucket>` |
| Semgrep rule tests | `secops.yml` / `semgrep-rules` | PR, push to `upgrade/vault`, nightly 03:43 UTC | a local rule that misses or over-matches its test cases | job log |
| CodeQL | `codeql.yml` (javascript-typescript, python, rust, c-cpp, actions; `security-extended`, no build) | PR, push to `upgrade/vault`, weekly | none on pre-existing alerts; new ones are annotated on the PR | code scanning (`codeql-<language>`) |
| zizmor | `secops.yml` / `zizmor` | PR, push, nightly | any finding in a workflow or `dependabot.yml` | run summary, code scanning (`zizmor`) |
| gitleaks | `secops.yml` / `gitleaks` | PR: the PR's commits; push / nightly / dispatch: full history | any leak not in `.gitleaksignore` | run summary (redacted), code scanning (`gitleaks`) |
| OSV-Scanner | `secops.yml` / `osv-scanner` | PR, push, nightly | a known vulnerability in any lockfile not excepted in `osv-scanner.toml` | run summary, code scanning (`osv-scanner`) |
| npm audit | `secops.yml` / `npm-audit` | PR, push, nightly | a **high** or **critical** advisory in the production dependencies (`--omit=dev`) | run summary |
| pip-audit | `secops.yml` / `pip-audit` | PR, push, nightly | any known vulnerability in `python/requirements-lock.txt` or the CI tool locks | run summary |
| cargo-deny | `secops.yml` / `cargo-deny` (light/, tools/x4m/rust) | PR, push, nightly | an advisory, a banned crate or a source outside `deny.toml` | job log |
| Dependabot | `.github/dependabot.yml` | GitHub's schedule | security updates only, one grouped PR per ecosystem (npm, cargo, pip, docker, github-actions); version updates off | PRs |

## What is scanned

- **Dependencies.** One npm lockfile covers every workspace (`package-lock.json`); `npm audit` runs after
  `npm ci --ignore-scripts`. `light/Cargo.lock` and `tools/x4m/rust/Cargo.lock` go through cargo-deny
  (`--locked`) and OSV. The Python bindings have no lock of their own for installs (`ci.yml` installs from
  `pyproject.toml`); `python/requirements-lock.txt` is their runtime set, hash-locked for CPython 3.12 on
  x86_64 Linux, so that it can be audited. Regenerate it when `pyproject.toml` changes (the command is its
  header). `tools/x4m/lwdprobe/go.mod` (a local measurement tool) is read by OSV; its versions follow
  lightwalletd-dd's. The CI tools are hash-locked too: `contrib/semgrep/requirements.txt` (shared with the
  node lines), `contrib/secops/requirements-{zizmor,pip-audit}.txt`; gitleaks, osv-scanner and cargo-deny
  are release binaries checked against the sha256 recorded in `secops.yml`. Every action is pinned by
  commit SHA.
- **Code.** Semgrep with the pinned packs (semgrep-rules `typescript`, `javascript`, `python`, `rust`, `c`,
  `bash`, `dockerfile`, `generic/secrets`, `yaml/github-actions`; Trail of Bits `python`, `rs`, `generic`,
  `yaml/github-actions`) and this repository's rules, `contrib/semgrep/rules/x402.yaml`:
  - `x402.payments.route-before-paywall` (high): an Express route registered before
    `app.use(paymentMiddleware(...))` is served without a verified payment. A paid resource is served only
    after the facilitator has verified it; a route that is free on purpose is accepted with its reason.
  - `x402.crypto.non-crypto-rng` (TypeScript `Math.random`), `-python` (`random`), `-rust` (`SmallRng`,
    `seed_from_u64`): nonces, keys, channel secrets and passwords come from a CSPRNG.
  - `x402.node.yed-write-rpc` (high): outside tests, x402-ycash never calls a `yed_*` RPC that moves or signs
    Yellowback state (`yed_send`, `yed_mint`, `yed_redeem`, …); it reaches the node through stock RPCs and
    the read-only `yed_*` RPCs (workspace `CLAUDE.md`, rule 2). `yed_getnewaddress` for change is allowed.

  Their test cases are `contrib/semgrep/rules/x402.{ts,py,rs}`. CodeQL covers the same languages with
  data-flow queries.

## Accepting a finding

Every exception carries a reason a reviewer can check:

- **Semgrep**: `contrib/semgrep/accepted.json` (by fingerprint, or a rule over paths), or `config.json`
  `exclude_rules` / `audit_rules` / `bucket_overrides`. See `contrib/semgrep/README.md`.
- **OSV-Scanner**: an `[[IgnoredVulns]]` entry in `osv-scanner.toml` with `reason` and an `ignoreUntil` at
  most 90 days out. Prefer fixing: bump the package in its lock. A Rust advisory goes in `deny.toml` too.
- **npm audit / pip-audit**: fix it in the lock; an unfixable advisory gets `--ignore-vuln ID` (pip-audit)
  in `secops.yml` with the reason in a comment, or (npm) an entry in `contrib/secops/npm-audit-exceptions.json`
  with the reason and an `until` at most 90 days out, read by `contrib/secops/npm-audit-gate.mjs`.
- **gitleaks**: a fingerprint in `.gitleaksignore` with a reason comment, for test vectors and public
  constants only. A real secret is rotated first, then removed. Note that a re-pinned vector file under
  `vectors/` shows up as a new hit (the fingerprint names the commit); add its fingerprints in the same PR.
- **zizmor**: fix the workflow; an intended pattern takes an inline `# zizmor: ignore[<audit>]` with the
  reason beside it.

## Repository settings

- Code scanning must be available (free for public repositories) for the SARIF uploads.
- For the Semgrep rolling PRs: *Settings → Actions → General → Allow GitHub Actions to create and approve
  pull requests*; optionally a `SEMGREP_PR_TOKEN` secret so CI runs on them (`contrib/semgrep/README.md`).
- Dependabot security updates on (*Settings → Code security*).
