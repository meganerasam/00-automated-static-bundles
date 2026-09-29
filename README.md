# Automated Static Bundle

Regenerates an extension's **static files from the latest uBlock Origin**, so a new
build ships current uBO data instead of a frozen copy inherited from a previous
build. Build-time tooling — run it on your Mac; it is **not** part of the PHP
server.

See `00 - Architecture/DATA_SOURCES.md` §4.1 for the why and the MV3 budget (§4.1.1).

---

## What it produces

A neutral bundle under `dist/`, which you then **re-partition / rename / restyle per
build** (the anti-template rule — `00 - Architecture/EXTENSION_COMPOSITION.md` §0.2):

```
dist/
  rulesets/                 DNR static rulesets (network blocking)  → rulesets/*.json
    ruleset-1.json …
    manifest-snippet.json   the declarative_net_request block to paste
  scriptlets/
    scriptlet-db.json       domain → [[name, ...args]]  → your *-db.js files
    scriptlets.js           the scriptlet code library (only the scriptlets used)
    used-scriptlets.json    the list of scriptlet names referenced by the DB
  cosmetic/
    generic.json            generic hide selectors (array)
    specific.json           { domain: { hide: [], unhide: [] } }
  surrogates/               the redirect/surrogate resource files
  report.json               counts, MV3-budget usage, and everything dropped
```

- **`rulesets/*.json`** → become your build's static DNR rulesets (Ninja:
  `defaultlist.json`, `defaultprivacy.json`, …).
- **`scriptlets/scriptlet-db.json`** → the data you split into your build's
  `*-db.js` (Ninja: `timers-db.js`, `abort-db.js`, `noop-db.js`, `prevent-db.js`,
  `scriptlet-details-db.js`), formatted however that frontend's scriptlet manager
  reads it.
- **`scriptlets/scriptlets.js`** → restyled into your `main-world.js` / `runtime.js`.
  **Must ship the same version the DB was built from** — the DB references
  scriptlets by name (DATA_SOURCES §4.1 coupling rule).
- **`cosmetic/*`** → your generic + specific cosmetic files.
- **`surrogates/*`** → your web-accessible surrogate resources.

## Source of truth

- **`uBlockOrigin/uAssets`** — filter lists (network + cosmetic + `##+js()`).
- **`@adguard/scriptlets`** — the scriptlet **code** library + redirect/surrogate
  resources, with uBO-compatible names (the "AdGuard tooling on uBO data" choice).
- **`@adguard/tsurlfilter`** — the network-filter → DNR converter.

Nothing from the `meganerasam` repos enters the static bundle — those feed the
*server* caches only (DATA_SOURCES §2.2 / §4.2).

## Run

```bash
# one-time: install Node 18+ (brew install node), then
npm install
npm run build            # fetch + convert + emit dist/
npm run build -- --report-only   # print what would be dropped, write nothing
```

Pin the uBO version and choose which lists to include in `config.json`.

## MV3 budget (enforced; DATA_SOURCES §4.1.1)

The converter **partitions and counts** against the current Chrome limits and warns
before you exceed them:

- Enabled **static** rules ≤ 30,000 (rulesets that ship enabled). Optional rulesets
  ship `enabled:false` and cost nothing until toggled.
- Regex rules ≤ 1,000 (per type); each regex rule < 2 KB — the converter prefers
  `urlFilter` and drops/flags anything over budget.
- (The **dynamic** safe/unsafe caps — 30,000 / 5,000 — apply to the *server's*
  compiled rules, not this static bundle; see DATA_SOURCES §4.1.1.)

`report.json` shows rules-per-ruleset, regex counts, and every filter the converter
could not express in DNR (those are handled by the runtime cosmetic/scriptlet layer,
not lost).

## Status — wired & tested

Wired against `@adguard/tsurlfilter@3.5.2` + `@adguard/scriptlets@2.5.1` and run
end-to-end on the current uAssets. A full run produced (numbers vary as uBO moves):

- **8 rulesets, ~119k DNR rules** — all valid (unique ids, proper action+condition;
  redirects, transforms, resource types, initiator domains).
- **scriptlet DB: ~31.8k domains, 91 scriptlets** (~44 with reference code emitted;
  the rest listed in `used-scriptlets.json` to implement).
- **cosmetics: ~29k generic, ~31.6k specific domains** (procedural/html skipped &
  counted).
- **surrogates: ~24 of ~47 referenced resources copied** (rest listed in
  `redirect-resources.json`).

**Expected, not bugs:**

- **Budget warning** — full easylist+easyprivacy is ~119k enabled static rules, far
  over MV3's 30k. That is the real constraint: ship a curated subset enabled, mark
  heavy rulesets `enabled:false` in `config.json`, and/or push the bulk to the
  server's dynamic compiled path (DATA_SOURCES §4.1.1 / §4.2).
- **`network skipped`** (UnsupportedModifier / InvalidDeclarativeRule) — filters
  DNR can't express ($csp, $header, some procedural). Handled by the runtime
  cosmetic/scriptlet layer, not lost. `report.json` counts them.
- **Unresolved scriptlets/surrogates** — names `@adguard/scriptlets` has no code/file
  for; the DB/names are complete, so wire those few by hand (the "little manual
  work").

The three integration points — `convert-network.js` (tsurlfilter),
`scriptlet-library.js` and `collect-surrogates.js` (@adguard/scriptlets) — are each
isolated in one file if a future package version shifts its API.

## Licensing

uAssets/uBO are **GPL-3.0**; `@adguard/*` carry their own (GPL/LGPL) terms. Deriving
from them is standard for filter lists but carries the usual attribution/source
obligations — recorded here as a fact, independent of any per-build restructuring.
