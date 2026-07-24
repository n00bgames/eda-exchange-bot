# EDA Exchange Bot

`EDA Exchange Bot` is a community addon for RedBlink Dune Docker Console built
from Easy Dune Admin's exchange seeder ([Icehunter/dune-admin
`internal/marketbot`](https://github.com/Icehunter/dune-admin/tree/main/internal/marketbot)).
It previews EDA's planned market listings and runs market seed and buyback
sweeps through RedBlink's permissioned addon bridge, without replacing the
standalone Easy Dune Admin panel.

Built from the
[dune-docker-addon-template](https://github.com/Red-Blink/dune-docker-addon-template).

See the [CHANGELOG](CHANGELOG.md) for what changed in each release, including
the fixes ported from Easy Dune Admin's market bot and the reasoning behind
them.

## Features

- **Market seeding**: seeds NPC sell listings for equipment, schematics,
  materials, ammunition, consumables, utility items, and cartography from a
  bundled Easy Dune Admin seed plan, with a configurable price multiplier.
- **Schematics at grades 1-5**: every schematic is listed at quality grades
  1 through 5 (2 listings per grade by default, configurable), priced with
  EDA's grade multipliers (`1.0, 1.0, 1.25, 1.5, 1.75, 2.0`).
- **More materials**: each material gets 4 listings by default (configurable)
  instead of a single stack.
- **Buyback sweeps**: buys eligible player sell listings at or below a
  configurable percentage of the seeded price, grade-aware using the same
  grade multipliers. Seller payment entries use EDA's fixes: per-unit
  `item_price` and the never-expires sentinel expiration (`999999999`) so the
  game server's expire proc cannot purge an uncollected "Take Solari" payment.
- **Unattended buyback (server-side schedule)**: on consoles with addon
  scheduler support
  ([Red-Blink/dune-awakening-selfhost-docker#103](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/103)),
  the console API process runs the buyback loop itself, so sweeps keep running
  with the addon page closed. The addon saves the schedule (interval,
  exchange, price multiplier, buyback percent, max buys) through typed bridge
  actions; the console builds all SQL server-side from the bundled seed plan
  and never accepts SQL for scheduled runs. Every run probes eligibility with
  a read-only query first and takes a pre-write backup only when there is
  something to buy. Requires the `scheduler:server` permission to be approved.
  The addon feature-detects console support and hides the section on older
  consoles.
- **Auto buyback (in-page)**: optional scheduler that runs the buyback sweep
  on an interval (default 30 minutes, minimum 10) while the addon page is
  open. Every run starts with a read-only eligibility query; the write sweep
  (and RedBlink's automatic pre-write backup) only happens when there is at
  least one eligible listing, so idle ticks are cheap on self-hosted servers.
  Kept as the fallback automation for consoles without scheduler support;
  while the server-side schedule is enabled, the in-page toggle is turned off
  to avoid redundant sweeps (and their backups).
- **Exchange detection**: resolves access points from
  `dune_exchange_accesspoints` first (the exchange players actually reach
  in-game) and refuses to fabricate one, matching EDA's exchange/access-point
  detection fixes.

## Repository Layout

```text
addon.json                 Addon identity, version, entry path, and permissions.
CHANGELOG.md               Release history and reasoning behind changes.
web/index.html             Addon HTML entry point.
web/addon.js               Addon behavior (preview, seed, buyback, scheduler).
web/addon.css              Addon styling.
web/dune-addon-bridge.js   Helper for calling console APIs.
web/market-seed-plan.json  Bundled Easy Dune Admin market seed plan.
scripts/validate.js        Manifest validation.
scripts/package.sh         Local packaging.
tests/                     Behavioral tests (jsdom UI harness + PostgreSQL).
package.json               Development-only test harness dependencies.
.github/workflows/         GitHub validation, tests, and release packaging.
```

The addon package itself is only `addon.json` plus `web/`.

## Permissions

The manifest requests `database:read`, `database:write`, and
`scheduler:server`. `database:read` populates the exchange selector and runs
the auto-buyback eligibility probe. `scheduler:server` lets the console run
the buyback schedule unattended (server-side sweeps still take the same
pre-write backups). RedBlink's Console API creates a database backup before
any write SQL runs through the addon bridge. No permissions are pre-approved
by installing; server owners approve them from RedBlink Console.

**Compatibility**: console builds without addon scheduler support
([Red-Blink/dune-awakening-selfhost-docker#103](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/103))
reject manifests that request unknown permissions, so addon 0.10.x only
installs on scheduler-capable consoles. Use addon 0.9.x on older consoles;
its in-page auto buyback still works there.

If the target server uses tightened PostgreSQL credentials, configure
RedBlink's Console container with its existing DB environment variables
(`ADMIN_DATABASE_URL` or `DUNE_DB_HOST`, `DUNE_DB_PORT`, `DUNE_DB_NAME`,
`DUNE_DB_USER`, `DUNE_DB_PASSWORD`). The addon iframe never receives DB
credentials.

## Validate

```bash
node scripts/validate.js
```

## Test

The behavioral tests load the real addon page in jsdom with a mock RedBlink
bridge, and execute the SQL the addon generates against a real PostgreSQL
server using a minimal replica of the exchange schema
(`tests/fixtures/dune-schema.sql`). They cover 64-bit exchange-id
preservation, exchange-scoped seeding cleanup, global cleanup, buyback SQL
generation and payment records, manual/automatic buyback concurrency, and the
server-side schedule wiring (feature detection, form-to-payload mapping,
permission-error surfacing, and probe/run actions).

```bash
npm install
npm test
```

A reachable PostgreSQL server is required for the `db-*.test.js` files; they
connect via the standard `PG*` environment variables (or the local socket)
and create/drop their own `eda_bot_test_*` databases. When `psql` is not
available those tests are skipped.

## Local Development

Copy the addon into a local Dune Docker Console install:

```bash
CONSOLE_DIR="$HOME/dune-awakening-selfhost-docker"
ADDON_ID="eda-exchange-bot"

mkdir -p "$CONSOLE_DIR/runtime/addons/installed/$ADDON_ID"
cp -a addon.json web "$CONSOLE_DIR/runtime/addons/installed/$ADDON_ID/"
```

Then enable it and approve the permissions you are testing:

```bash
cd "$CONSOLE_DIR"

python3 - <<'PY'
import json
from pathlib import Path

addon_id = "eda-exchange-bot"
permissions = ["database:read", "database:write", "scheduler:server"]

state_path = Path("runtime/addons/state.json")
state_path.parent.mkdir(parents=True, exist_ok=True)

try:
    state = json.loads(state_path.read_text())
except Exception:
    state = {}

state[addon_id] = {
    "enabled": True,
    "approvedPermissions": permissions
}

state_path.write_text(json.dumps(state, indent=2) + "\n")
PY
```

Refresh Dune Docker Console and open **Addons**. For community-review-safe
installs, set `"enabled": False` and an empty permission list instead, and
enable from the console UI.

## Package

On Linux with `zip` installed:

```bash
bash scripts/package.sh
```

This creates:

```text
dist/eda-exchange-bot-<version>.zip
dist/eda-exchange-bot-<version>.zip.sha256
```

## Release

1. Make sure `addon.json.version` is correct.
2. Create and push a matching tag:

   ```bash
   git tag v0.9.0
   git push origin v0.9.0
   ```

GitHub Actions validates the addon, packages it, creates the GitHub Release,
and uploads the zip plus its SHA-256 checksum.

## Submit To The Community Index

When ready for public discovery in Dune Docker Console, open a pull request to
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
adding `addons/eda-exchange-bot.json` and updating `index.json`. Lifecycle
status (`active`, `deprecated`, `unsupported`, `removed`, `blocked`) is managed
by the community index, not this repository's `addon.json`.
