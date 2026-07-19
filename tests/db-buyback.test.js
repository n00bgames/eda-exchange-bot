"use strict";

// Buyback behavior against a real PostgreSQL server: payment records, order
// consumption, balance movement, exchange scoping, and the automatic sweep,
// all driven through the real UI with the bridge backed by the database.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHarness, exchangeRow } = require("./helpers/harness");
const db = require("./helpers/db");

const DB_NAME = "eda_bot_test_buyback";
const FIXTURE = path.join(__dirname, "fixtures", "dune-schema.sql");
const SENTINEL = "999999999";

const EX_A = "9007199254740993";
const EX_B = "9223372036854775807";
const AP_A = "101";
const AP_B = "102";
const PLAYER_ID = "900001";

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
  harness.onQuery = async ({ query }) => {
    // The auto-buyback eligibility probe runs read-only against the real DB;
    // everything else is the exchange-discovery query.
    if (query.includes("eligible_orders")) return { rows: db.queryObjects(DB_NAME, query) };
    return { rows: exchangeRows() };
  };
  await harness.loadExchangesWithRows(exchangeRows());
  return harness;
}

// Payment ("Take Solari") rows: sentinel-expiring player-owned orders. The
// bot's own first-seed listings may also carry the sentinel (no earlier
// orders to derive an expiry from), so filter on is_npc_order too.
function paymentOrders() {
  return db.queryObjects(DB_NAME, `
    SELECT id::text, owner_id::text, template_id, item_price::text, expiration_time::text, is_npc_order::text, item_id::text
    FROM dune.dune_exchange_orders
    WHERE expiration_time = ${SENTINEL} AND is_npc_order = FALSE
    ORDER BY template_id`);
}

test("buyback sweeps against PostgreSQL", { skip: !available && "psql is not available" }, async (t) => {
  db.createTestDb(DB_NAME);
  db.loadFixture(DB_NAME, FIXTURE);
  db.execSql(DB_NAME, `
    INSERT INTO dune.dune_exchange_accesspoints (id, exchange_id) VALUES
      (${AP_A}, ${EX_A}),
      (${AP_B}, ${EX_B});
    INSERT INTO dune.actors (id, class, partition_id) VALUES (${PLAYER_ID}, 'BP_DuneCharacter', 1);
    SELECT dune.dune_exchange_get_user_id(${PLAYER_ID});`);
  t.after(() => db.dropTestDb(DB_NAME));

  const harness = await dbBackedHarness();

  // Seed exchange A so the bot actor exists with a topped-up balance.
  harness.el("exchangeId").value = EX_A;
  const seedSql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(seedSql, `seed write did not run: ${harness.statusText()}`);
  const botId = db.queryOne(DB_NAME, "SELECT id::text FROM dune.actors WHERE class = 'Revy'");
  assert.equal(db.queryOne(DB_NAME, `SELECT solari_balance::text FROM dune.dune_exchange_users WHERE owner_id = ${botId}`), "9000000000000");

  // Player listings. Buyback plan at 60%: TestOre max 300/unit, TestRifle max
  // 3000/unit at grade 0 (4500 at grade 3).
  db.execSql(DB_NAME, `
    INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id, quality_level) VALUES
      (800001, ${EX_A}, 100, 9001, 'TestOre', 0),
      (800002, ${EX_A}, 100, 9002, 'TestOre', 0),
      (800003, ${EX_A}, 1, 9003, 'TestRifle', 3),
      (800004, ${EX_A}, 1, 9004, 'UnknownThing', 0),
      (800005, ${EX_B}, 100, 9005, 'TestOre', 0);
    INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, quality_level, item_id) VALUES
      (700001, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'TestOre', 250, 0, 800001),
      (700002, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'TestOre', 400, 0, 800002),
      (700003, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'TestRifle', 4000, 3, 800003),
      (700004, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'UnknownThing', 10, 0, 800004),
      (700005, ${EX_B}, ${AP_B}, ${PLAYER_ID}, FALSE, 123456, 'TestOre', 100, 0, 800005);
    INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES
      (700001, 100, 250), (700002, 100, 400), (700003, 1, 4000), (700004, 1, 10), (700005, 100, 100);`);

  await t.test("manual sweep buys eligible orders and writes payment records", async () => {
    const sql = await harness.clickAndCaptureSql("buySweep");
    assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);

    // 700001 (250 <= 300) and 700003 (4000 <= 3000 * 1.5 grade multiplier)
    // are bought; 700002 is over threshold, 700004 has an unknown template,
    // and 700005 sits on a different exchange.
    const remaining = db.queryRows(DB_NAME, `SELECT id::text FROM dune.dune_exchange_orders WHERE id IN (700001,700002,700003,700004,700005) ORDER BY id`).map((row) => row[0]);
    assert.deepEqual(remaining, ["700002", "700004", "700005"]);
    // Bought items are consumed, the rest keep their backing items.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items WHERE id IN (800001, 800003)"), "0");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items WHERE id IN (800002, 800004, 800005)"), "3");

    // Payment records: seller-owned "Take Solari" rows with per-unit price,
    // the never-expires sentinel, is_npc_order = FALSE, and no backing item.
    const payments = paymentOrders();
    assert.equal(payments.length, 2);
    assert.deepEqual(payments.map((row) => [row.template_id, row.owner_id, row.item_price, row.expiration_time, row.is_npc_order, row.item_id]), [
      ["TestOre", PLAYER_ID, "250", SENTINEL, "false", ""],
      ["TestRifle", PLAYER_ID, "4000", SENTINEL, "false", ""]
    ]);
    // Payment rows must not be re-listed for sale.
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.dune_exchange_sell_orders s JOIN dune.dune_exchange_orders o ON o.id = s.order_id WHERE o.expiration_time = ${SENTINEL} AND o.is_npc_order = FALSE`), "0");

    // Fulfilled-order audit rows link each payment to the consumed order.
    const fulfilled = db.queryObjects(DB_NAME, `
      SELECT f.completion_type::text, f.stack_size::text, f.original_order_id::text, o.template_id
      FROM dune.dune_exchange_fulfilled_orders f
      JOIN dune.dune_exchange_orders o ON o.id = f.order_id
      ORDER BY o.template_id`);
    assert.deepEqual(fulfilled.map((row) => [row.template_id, row.completion_type, row.stack_size, row.original_order_id]), [
      ["TestOre", "4", "100", "700001"],
      ["TestRifle", "4", "1", "700003"]
    ]);

    // Bot paid 250 * 100 + 4000 * 1 = 29000 Solari.
    assert.equal(
      db.queryOne(DB_NAME, `SELECT solari_balance::text FROM dune.dune_exchange_users WHERE owner_id = ${botId}`),
      String(9000000000000 - 29000)
    );
  });

  await t.test("automatic sweep buys a newly eligible order end-to-end", async () => {
    db.execSql(DB_NAME, `
      INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id) VALUES (800006, ${EX_A}, 50, 9006, 'TestOre');
      INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, item_id)
      VALUES (700006, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'TestOre', 200, 800006);
      INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (700006, 50, 200);`);
    const balanceBefore = db.queryOne(DB_NAME, `SELECT solari_balance::text FROM dune.dune_exchange_users WHERE owner_id = ${botId}`);

    harness.setCheckbox("autoBuyback", true);
    harness.advanceTime(31 * 60000);
    harness.autoTick();
    await harness.waitFor(() => harness.autoStatusText().includes("sweep finished"), { label: "auto sweep completion" });

    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE id = 700006"), "0");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items WHERE id = 800006"), "0");
    assert.equal(paymentOrders().filter((row) => row.item_price === "200").length, 1);
    assert.equal(
      db.queryOne(DB_NAME, `SELECT solari_balance::text FROM dune.dune_exchange_users WHERE owner_id = ${botId}`),
      String(Number(balanceBefore) - 200 * 50)
    );
  });

  await t.test("automatic sweep skips the write when nothing is left to buy", async () => {
    const writesBefore = harness.executedSql().length;
    harness.advanceTime(31 * 60000);
    harness.autoTick();
    await harness.waitFor(() => harness.autoStatusText().includes("nothing eligible"), { label: "idle auto tick" });
    assert.equal(harness.executedSql().length, writesBefore, "no write may run when the eligibility probe finds nothing");
  });
});
