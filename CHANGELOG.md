# Changelog

Notable changes to the EDA Exchange Bot addon. Written for RedBlink (console
maintainer review) and n00bGames (addon author), documenting what changed and
why.

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
