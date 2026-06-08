# matching-engine — Dependency Scan (npm audit)

- **Date:** 2026-06-08
- **Scope:** external-audit prep (hub-only launch), Phase 0.3
- **Tool:** `npm audit --json` (npm 10.9.2)
- **Raw output:** [`dependency-scan-2026-06-08.json`](./dependency-scan-2026-06-08.json)
- **Dependencies audited:** 446 total (42 prod, 404 dev, 3 optional)

> **Note on method:** this repo's committed lockfile is `pnpm-lock.yaml`
> (`package-lock.json` is gitignored). `npm audit` requires an npm lockfile, so
> the scan was run against a transient `package-lock.json` generated from
> `package.json` in a clean temp dir (`npm install --package-lock-only`). No
> npm lockfile was added to the repo; runtime installs still use pnpm.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 6 |
| Moderate | 1 |
| Low | 0 |
| **Total** | **7** |

All 7 findings are **dev-only / not reachable from the deployed runtime** and
every available fix is a **semver-major** bump. Nothing was patched in this pass
(a major dev-toolchain bump needs separate lint + test re-validation, out of
audit-prep scope); all are **accepted for the audit window** with the rationale
and recommended follow-up below.

## Findings & disposition

### H1 — `minimatch` ReDoS (×6 advisories, via `@typescript-eslint` v6 chain)

- **Packages:** `minimatch`, `@typescript-eslint/{eslint-plugin,parser,type-utils,typescript-estree,utils}`
- **Advisory:** multiple ReDoS in `minimatch` (repeated wildcards, GLOBSTAR
  backtracking, nested extglobs). All six reported "high" entries share this one
  root cause — `minimatch` pulled in transitively by the `@typescript-eslint` v6
  lint toolchain.
- **Reachability:** **dev-only.** `@typescript-eslint`/`eslint`/`minimatch` are
  `devDependencies` used by `npm run lint` on developer/CI machines. The deployed
  container runs compiled JS (`node dist/services/*.js`) and never loads ESLint or
  `minimatch`. No attacker-controlled input reaches glob matching at runtime.
- **Fix available:** `@typescript-eslint` `8.60.1` (**semver-major**, 6→8) which
  pulls `minimatch` ≥10.
- **Disposition:** **ACCEPTED** for the audit window. Bumping `@typescript-eslint`
  6→8 also requires moving the ESLint config off the v6 `parserOptions`/plugin
  shape and re-validating `npm run lint`. Recommend a separate
  `chore(deps): bump @typescript-eslint to v8` PR, tracked post-audit. No
  production-runtime exposure.

### M1 — `uuid` missing buffer bounds check (v3/v5/v6 with `buf` arg)

- **Package:** `uuid` (installed `^9.0.1`; advisory affects `<11.1.1`)
- **Advisory:** missing bounds check when a caller-supplied `buf` is passed to the
  `v3`/`v5`/`v6` generators.
- **Reachability:** **not reachable.** Runtime uses only `uuid.v4()` (random, no
  `buf`) — `src/utils/helpers.ts`. The lone `v5` use is in a test factory
  (`src/__tests__/factories/order-factory.ts`) and passes no `buf`. The vulnerable
  code path is never invoked.
- **Fix available:** `uuid` `14.0.0` (**semver-major**).
- **Disposition:** **ACCEPTED.** Not exploitable given current usage; defer the
  major bump to routine dependency maintenance.

## Recommended follow-up (post-audit, not blocking)

1. `chore(deps): bump @typescript-eslint to v8` — clears all 6 high findings;
   needs ESLint flat/parser config review + `npm run lint` re-validation.
2. `chore(deps): bump uuid to v14` — clears M1; check `v4()` call sites still
   compile against the v14 API.
