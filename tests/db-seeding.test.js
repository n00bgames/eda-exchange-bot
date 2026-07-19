"use strict";

// Bug 2 behavioral tests against a real PostgreSQL server: the SQL captured
// from the real UI is executed against a minimal replica of the exchange
// schema. Reseeding one exchange must never touch another exchange's bot
// listings, while the explicit "Clear EDA NPC Listings" action stays global.
// 64-bit exchange ids are used throughout so precision loss would surface as
// missing or misplaced rows.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHarness, exchangeRow } = require("./helpers/harness");
const db = require("./helpers/db");

const DB_NAME = "eda_bot_test_seeding";
const FIXTURE = path.join(__dirname, "fixtures", "dune-schema.sql");

// 2^53 + 1 and BIGINT max: both unrepresentable as JS numbers.
const EX_A = "9007199254740993";
const EX_B = "9223372036854775807";
const AP_A = "101";
const AP_B = "102";

// Test seed plan at default settings: TestRifle 2 + TestSchematic (5 grades x
// 2) + TestOre 4 + TestAugment 1 = 17 listings per seeded exchange.
const LISTINGS_PER_SEED = 17;

const available = db.psqlAvailable();

function exchangeRows() {
  return [
    exchangeRow({ exchange_id: EX_A, access_point_count: "1" }),
    exchangeRow({ exchange_id: EX_B, access_point_count: "1" })
  ];
}

async function dbBackedHarness() {
  const harness = await createHarness();
  harness.onExecute = async ({ query }) => { db.execSql(DB_NAME, query); return { rows: [] }; };
  await harness.loadExchangesWithRows(exchangeRows());
  return harness;
}

function botOrderCount(exchangeId) {
  return Number(db.queryOne(DB_NAME, `
    SELECT COUNT(*) FROM dune.dune_exchange_orders o
    JOIN dune.actors a ON a.id = o.owner_id
    WHERE a.class = 'Revy' AND o.exchange_id = ${exchangeId}`));
}

test("seeding and cleanup against PostgreSQL", { skip: !available && "psql is not available" }, async (t) => {
  db.createTestDb(DB_NAME);
  db.loadFixture(DB_NAME, FIXTURE);
  db.execSql(DB_NAME, `
    INSERT INTO dune.dune_exchange_accesspoints (id, exchange_id) VALUES
      (${AP_A}, ${EX_A}),
      (${AP_B}, ${EX_B});`);
  t.after(() => db.dropTestDb(DB_NAME));

  const harness = await dbBackedHarness();

  await t.test("seeding preserves the exact 64-bit exchange id", async () => {
    harness.el("exchangeId").value = EX_A;
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(DISTINCT exchange_id) FROM dune.dune_exchange_orders"), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT DISTINCT exchange_id::text FROM dune.dune_exchange_orders"), EX_A);
    // The corrupted double-precision neighbor must not appear anywhere.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE exchange_id = 9007199254740992"), "0");
    assert.equal(db.queryOne(DB_NAME, `SELECT DISTINCT access_point_id::text FROM dune.dune_exchange_orders`), AP_A);
    // Backing items land in exchange A's inventory with matching sell orders.
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_A}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), String(LISTINGS_PER_SEED));
  });

  await t.test("seeding a second exchange leaves the first untouched", async () => {
    harness.el("exchangeId").value = EX_B;
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    assert.equal(botOrderCount(EX_B), LISTINGS_PER_SEED);
  });

  let exchangeAOrderIdsBeforeReseed;
  await t.test("reseeding with clear-existing only replaces the selected exchange", async () => {
    exchangeAOrderIdsBeforeReseed = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_A} ORDER BY id`).map((row) => row[0]);
    const exchangeBOrderIdsBefore = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_B} ORDER BY id`).map((row) => row[0]);

    harness.el("exchangeId").value = EX_A;
    assert.equal(harness.el("clearExisting").checked, true, "clear-existing is on by default");
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `reseed write did not run: ${harness.statusText()}`);

    // Exchange A was cleared and reseeded: same count, all-new order ids.
    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    const exchangeAOrderIdsAfter = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_A} ORDER BY id`).map((row) => row[0]);
    for (const oldId of exchangeAOrderIdsBeforeReseed) {
      assert.ok(!exchangeAOrderIdsAfter.includes(oldId), `old exchange A order ${oldId} must be deleted`);
    }
    // The reported bug: exchange B's bot listings must survive byte-for-byte.
    const exchangeBOrderIdsAfter = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_B} ORDER BY id`).map((row) => row[0]);
    assert.deepEqual(exchangeBOrderIdsAfter, exchangeBOrderIdsBefore, "reseeding exchange A must not delete exchange B's orders");
    // Old exchange A backing items were deleted, exchange B's kept.
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_A}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_B}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), String(2 * LISTINGS_PER_SEED));
  });

  await t.test("global clear removes bot listings from every exchange but spares players", async () => {
    // A player listing that must survive both cleanups.
    db.execSql(DB_NAME, `
      INSERT INTO dune.actors (id, class, partition_id) VALUES (900001, 'BP_DuneCharacter', 1);
      INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id) VALUES (800001, ${EX_A}, 10, 9999, 'TestOre');
      INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, item_id)
      VALUES (700001, ${EX_A}, ${AP_A}, 900001, FALSE, 123456, 'TestOre', 111, 800001);
      INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (700001, 10, 111);`);

    const sql = await harness.clickAndCaptureSql("clearNpc");
    assert.ok(sql, `clear write did not run: ${harness.statusText()}`);
    assert.match(harness.confirmMessages.at(-1), /ALL exchanges/);

    assert.equal(botOrderCount(EX_A), 0);
    assert.equal(botOrderCount(EX_B), 0);
    // Only the player's order, sell order, and item survive.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders"), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT id::text FROM dune.dune_exchange_orders"), "700001");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items"), "1");
  });
});
