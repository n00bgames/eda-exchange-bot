# Changelog

Notable changes to the EDA Exchange Bot addon. Written for RedBlink (console
maintainer review) and n00bGames (addon author), documenting what changed and
why.

## 0.9.2 - 2026-07-19

Fix for the buyback concurrency issue from RedBlink's 0.9.1 review, plus a
corrected release. This entry was previously mislabeled as a second 0.9.1
section: the concurrency fix was tagged `0.9.1` (without the `v` prefix), so
the `v*` release workflow never rebuilt the archive and the published v0.9.1
zip did not contain it. 0.9.2 is a clean, immutable release built from the
corrected source.

### Release

- Republished as `v0.9.2` so the release workflow rebuilds the archive from
  the corrected source; the published zip now contains the concurrency fix.
- Version fields aligned: `addon.json`, `package.json`, and the release tag
  all report 0.9.2 (they previously disagreed between 0.9.1 and 0.9.2).
- Removed stale committed `dist/` archives (0.9.0 and 0.9.1) from the
  repository; `dist/` is gitignored and release archives are built by the
  `v*` tag workflow. The committed 0.9.1 zip's checksum no longer matched
  the published release asset, which is what broke the catalog manifest's
  SHA-256.

### Fixed

- **Database-level buyback concurrency protection**: the buyback sweep's
  order-selection loop now locks the rows it processes with
  `FOR UPDATE OF o, s SKIP LOCKED`. The existing `writeInProgress` flag only
  protects a single browser page; two tabs or administrators sweeping at the
  same time could previously select the same player order twice, creating a
  duplicate seller payment and debiting the bot's balance twice. With row
  locking, a concurrent sweep skips orders another sweep has already claimed
  (and rows deleted by a committed sweep drop out of the re-checked result),
  so each order is purchased exactly once no matter how many sweeps run.
- The sweep no longer calls `dune_exchange_get_user_id` (its result was
  unused): the function's `INSERT .. ON CONFLICT` would block on another
  sweep's uncommitted balance update, needlessly serializing sweeps that
  `SKIP LOCKED` lets run side by side. The balance top-up still creates the
  bot's exchange-users row when it is missing.

### Tests

- New PostgreSQL-backed concurrency test
  (`tests/db-buyback-concurrency.test.js`) runs two sweeps on separate
  database connections against the same eligible order, both as overlapping
  transactions (the second runs while the first is still uncommitted) and as
  a simultaneous race. It verifies the order is purchased exactly once, only
  one payment record is created, and the bot's balance is deducted exactly
  once; without the row locking the test fails with a double purchase.
- `tests/helpers/db.js` gained `openSession()`: a long-lived interactive
  psql session (one connection per session) so tests can hold a transaction
  open while another runs concurrently.

## 0.9.1 - 2026-07-19

Fixes for the two blocking issues from RedBlink's 0.9.0 review, plus the
behavioral test suite requested with them.

### Fixed

- **BIGINT exchange ids preserved exactly**: exchange ids are now handled as
  validated decimal strings (`/^[1-9][0-9]*$/`, capped at the PostgreSQL
  BIGINT maximum) end-to-end: the dropdown, the remembered-id storage, and
  the generated SQL. They are never converted with `Number()`, so BIGINT ids
  above `Number.MAX_SAFE_INTEGER` (2^53 - 1) can no longer lose precision and
  target the wrong exchange. `BigInt` is used only for numeric sorting of the
  dropdown. The manual "Remember Exchange ID" input became a text field with
  numeric input hints so the browser cannot round large ids either.
- **"Clear existing listings before seeding" is scoped to the selected
  exchange**: the pre-seed cleanup now resolves the selected exchange first
  and constrains every order, sell-order, and backing-item deletion to
  `owner_id = v_owner_id AND exchange_id = v_exchange_id`. Reseeding one
  exchange no longer removes the bot's listings from every other seeded
  exchange. The checkbox label now says "the selected exchange's" listings.
- The explicit **Clear EDA NPC Listings** action intentionally stays global,
  and its confirmation prompt now states that it removes the bot's listings
  from ALL exchanges, not just the selected one.

### Tests

New behavioral test suite (`npm test`, run by CI): jsdom drives the real
addon page against a mock RedBlink bridge, and the captured SQL is executed
against a real PostgreSQL server with a minimal replica of the exchange
schema (`tests/fixtures/dune-schema.sql`). Covered:

- Exact preservation of 64-bit exchange ids (2^53 + 1 and BIGINT max)
  through the dropdown, localStorage, generated SQL, and database rows.
- Seeding cleanup affecting only the selected exchange (reseeding exchange A
  leaves exchange B's orders byte-for-byte intact).
- Global cleanup behavior (bot listings removed from every exchange, player
  listings spared, confirmation warns about all exchanges).
- Buyback SQL generation and payment records (threshold rounding, grade
  normalization, per-unit seller payments with the never-expires sentinel,
  fulfilled-order audit rows, Solari balance movement, exchange scoping).
- Manual and automatic buyback concurrency (single write in flight, auto
  ticks skipped during manual writes, no immediate run on arming, idle ticks
  skip the write).

The test harness (`package.json`, `tests/`) is development-only; the shipped
addon package remains `addon.json` plus `web/`.

## 0.9.0 - 2026-07-11

### Template adherence ([dune-docker-addon-template](https://github.com/Red-Blink/dune-docker-addon-template))

- Split the single-file `web/index.html` (inline styles and script) into
  `web/index.html` + `web/addon.js` + `web/addon.css`, matching the template's
  repository layout. No behavior was lost in the split; all behavior changes
  are listed below.
- Rewrote `README.md` to follow the template's structure (validate, local
  development, package, release, community-index submission) and removed
  references to `install-eda-exchange-bot.sh` and
  `patch-redblink-local-addons.sh`, which were documented but not present in
  this repository. Local testing now follows the template's documented flow
  (copy `addon.json` + `web/` into `runtime/addons/installed/`, enable via
  `runtime/addons/state.json`).
- The GitHub workflows and `scripts/validate.js` already matched the template
  byte-for-byte and are unchanged. The addon package remains `addon.json` plus
  `web/` only.

### Fixes ported from Easy Dune Admin's exchange seeder ([Icehunter/dune-admin `internal/marketbot`](https://github.com/Icehunter/dune-admin/tree/main/internal/marketbot))

- **Seller payment fix** ("items eaten without payment"): buyback payment
  entries ("Take Solari" rows) now use the never-expires sentinel expiration
  `999999999` instead of a derived future timestamp. The game server's
  `dune_exchange_expire_orders` proc runs about every 5 minutes and purges
  past-dated orders; a payment entry that lands in the past means the seller's
  item is consumed with no Solari paid out. `item_price` on the payment entry
  stays per-unit (the game multiplies by stack size itself).
- **Access-point detection**: market seeding resolves the access point from
  `dune.dune_exchange_accesspoints` first (authoritative: it is what the game
  client uses), falls back to an existing order's access point, and raises a
  clear error instead of fabricating id `1`. A fabricated id violates the
  foreign key and produces listings players cannot see in-game. The exchange
  selector also shows access-point counts and prefers exchanges that have one.
- **Listing expiry**: seeded-listing expiration is derived from the newest
  non-sentinel order and capped at the sentinel, so sentinel payment rows can
  no longer inflate the computed expiry past `999999999`.
- **Balance seeding**: the bot's Solari balance is topped up to 9T only when
  it dips below the 1T floor, instead of topping up on every run.
- **Grade multipliers**: adopted the marketbot's quality-grade price
  multipliers `[1.0, 1.0, 1.25, 1.5, 1.75, 2.0]` (grades 0-5) for both
  listing prices and grade-aware buyback thresholds.

### New features

- **Schematics at grades 1-5**: every schematic in the seed plan now lists at
  quality grades 1 through 5, with 2 listings per grade by default
  (configurable 1-20), priced with the grade multipliers above. At defaults
  this turns 496 schematic templates into 4,960 schematic listings.
- **More materials**: each material (resource row) now seeds 4 listings by
  default (configurable 1-50) instead of a single listing: 102 material
  listings become 408 (~189k resource units).
- **Auto buyback**: an opt-in scheduler runs the buyback sweep on an interval
  (default 30 minutes, minimum 10) while the addon page is open in the
  console. Designed to be gentle on self-hosted infrastructure:
  - Every tick starts with a **read-only** eligibility query through
    `database.query`, which takes no backup. The backup-protected
    `database.execute` sweep only runs when at least one eligible player
    listing exists, so idle ticks are cheap.
  - Arming the toggle never fires immediately; the first run happens one full
    interval after enabling.
  - The interval is measured from sweep completion, so a slow backup or write
    can never cause back-to-back runs.
  - Because addons are iframe pages with no server-side scheduler in the
    bridge, the automation runs only while the page is open.
- **Grade-aware buyback**: player listings are compared against a
  grade-adjusted reference price (the order's `quality_level` applied to the
  same grade multipliers used for seeding) before the buyback threshold
  percentage is applied.
- Panel settings (multiplier, threshold, max buys, grade/material counts,
  auto-buyback toggle and interval) persist in browser `localStorage`. The
  seed-row preview table gained a Grade column and grade filtering.

### Fixes from Cursor Bugbot review of this release

- **Overlapping write sweeps**: `executeWrite` returns early when a write is
  already in progress, closing a race where a manual sweep started during the
  auto-buyback eligibility probe could run concurrently with the auto sweep.
- **Auto buyback false success**: write helpers return a success flag and the
  auto status reports failed sweeps instead of always showing "sweep
  finished".
- **Auto interval ignores long writes**: the next-run timer re-arms from
  completion time in a `finally` block (see auto-buyback design above).
- **Buyback double-applied grade pricing**: 77 bundled plan rows (T6
  augments) carry a non-zero `quality_level` with already grade-adjusted
  prices; they are now normalized back to grade-0 prices before the buyback
  plan is built, since the SQL applies the grade multiplier itself.

### Housekeeping

- Version bumped from `0.8.7-beta` to `0.9.0` in `addon.json`.

## 0.8.7-beta

Baseline release: single-file addon page with market seed preview, manual
seed / buyback / clear / drop-unsafe actions, and the bundled Easy Dune Admin
market seed plan.
