"use strict";

// Database-level buyback concurrency against a real PostgreSQL server: two
// sweeps in separate connections must never buy the same order twice. The
// page's writeInProgress flag only guards one browser tab; the SQL itself
// guards cross-tab/cross-admin races with FOR UPDATE SKIP LOCKED.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHarness, exchangeRow } = require("./helpers/harness");
const db = require("./helpers/db");

const DB_NAME = "eda_bot_test_buyback_concurrency";
const FIXTURE = path.join(__dirname, "fixtures", "dune-schema.sql");
const SENTINEL = "999999999";

const EX_A = "5001";
const AP_A = "201";
const PLAYER_ID = "910001";
const SEEDED_BALANCE = 9000000000000;

const available = db.psqlAvailable();

function exchangeRows() {
  return [exchangeRow({ exchange_id: EX_A, access_point_count: "1" })];
}

// First column of the first result row (market_buy_result.purchased) from a
// sweep's psql -A -t output.
function purchasedCount(sessionResult) {
  const lines = sessionResult.stdout.split("\n").filter((line) => line.length > 0);
  assert.ok(lines.length >= 1, `sweep produced no result rows:\n${sessionResult.stdout}\n${sessionResult.stderr}`);
  return Number(lines[0].split("|")[0]);
}

function botBalance(botId) {
  return db.queryOne(DB_NAME, `SELECT solari_balance::text FROM dune.dune_exchange_users WHERE owner_id = ${botId}`);
}

function paymentCount(price) {
  return db.queryOne(DB_NAME, `
    SELECT COUNT(*) FROM dune.dune_exchange_orders
    WHERE expiration_time = ${SENTINEL} AND is_npc_order = FALSE AND item_price = ${price}`);
}

function insertEligibleOrder(orderId, itemId, price) {
  db.execSql(DB_NAME, `
    INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id) VALUES (${itemId}, ${EX_A}, 100, ${itemId}, 'TestOre');
    INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, item_id)
    VALUES (${orderId}, ${EX_A}, ${AP_A}, ${PLAYER_ID}, FALSE, 123456, 'TestOre', ${price}, ${itemId});
    INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (${orderId}, 100, ${price});`);
}

test("concurrent buyback sweeps against PostgreSQL", { skip: !available && "psql is not available" }, async (t) => {
  db.createTestDb(DB_NAME);
  db.loadFixture(DB_NAME, FIXTURE);
  db.execSql(DB_NAME, `
    INSERT INTO dune.dune_exchange_accesspoints (id, exchange_id) VALUES (${AP_A}, ${EX_A});
    INSERT INTO dune.actors (id, class, partition_id) VALUES (${PLAYER_ID}, 'BP_DuneCharacter', 1);
    SELECT dune.dune_exchange_get_user_id(${PLAYER_ID});`);
  t.after(() => db.dropTestDb(DB_NAME));

  // Seed once through the real UI so the bot actor exists with a committed,
  // topped-up balance before any concurrent sweep starts.
  const harness = await createHarness();
  harness.onExecute = async ({ query }) => { db.execSql(DB_NAME, query); return { rows: [] }; };
  harness.onQuery = async () => ({ rows: exchangeRows() });
  await harness.loadExchangesWithRows(exchangeRows());
  harness.el("exchangeId").value = EX_A;
  const seedSql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(seedSql, `seed write did not run: ${harness.statusText()}`);
  const botId = db.queryOne(DB_NAME, "SELECT id::text FROM dune.actors WHERE class = 'Revy'");
  assert.equal(botBalance(botId), String(SEEDED_BALANCE));

  // Capture the exact sweep SQL the UI would hand the bridge, without
  // executing it; both concurrent sessions replay this same script.
  harness.onExecute = async () => ({ rows: [] });
  const sweepSql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sweepSql, `buyback write did not run: ${harness.statusText()}`);
  assert.match(sweepSql, /FOR UPDATE OF o, s SKIP LOCKED/);
  const sweepSqlWithoutCommit = sweepSql.replace(/COMMIT;\s*$/, "");
  assert.notEqual(sweepSqlWithoutCommit, sweepSql, "sweep script must end in COMMIT");

  await t.test("a sweep overlapping an uncommitted sweep skips the locked order", async () => {
    // One eligible player listing: TestOre at 250/unit x 100 (plan max 300).
    insertEligibleOrder(710001, 810001, 250);

    const sessionA = db.openSession(DB_NAME);
    const sessionB = db.openSession(DB_NAME);
    try {
      // Sweep A buys the order but does not commit, so it still holds the
      // row locks when sweep B runs the very same script.
      const resultA = await sessionA.run(sweepSqlWithoutCommit);
      assert.equal(resultA.stderr, "", `sweep A must not error: ${resultA.stderr}`);
      assert.equal(purchasedCount(resultA), 1, "sweep A must buy the eligible order");

      // Without SKIP LOCKED row locking, sweep B would see A's snapshot of
      // the order, buy it again, and block on the bot balance row until A
      // commits. With the guard it finishes immediately, buying nothing.
      const promiseB = sessionB.run(sweepSql);
      const finishedBeforeACommits = await Promise.race([
        promiseB.then(() => true),
        new Promise((resolve) => setTimeout(resolve, 5000, false))
      ]);
      await sessionA.run("COMMIT;");
      const resultB = await promiseB;
      assert.equal(finishedBeforeACommits, true, "concurrent sweep must skip locked orders, not block on them");
      assert.equal(resultB.stderr, "", `sweep B must not error: ${resultB.stderr}`);
      assert.equal(purchasedCount(resultB), 0, "concurrent sweep must not buy the already-claimed order");
    } finally {
      sessionA.close();
      sessionB.close();
    }

    // Purchased exactly once: order and item consumed, one payment record,
    // one fulfilled audit row, and the bot debited a single 250 * 100.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE id = 710001"), "0");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items WHERE id = 810001"), "0");
    assert.equal(paymentCount(250), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_fulfilled_orders WHERE original_order_id = 710001"), "1");
    assert.equal(botBalance(botId), String(SEEDED_BALANCE - 250 * 100));
  });

  await t.test("two simultaneous full sweeps buy the order exactly once", async () => {
    insertEligibleOrder(710002, 810002, 260);
    const balanceBefore = Number(botBalance(botId));

    const sessionA = db.openSession(DB_NAME);
    const sessionB = db.openSession(DB_NAME);
    let resultA;
    let resultB;
    try {
      [resultA, resultB] = await Promise.all([sessionA.run(sweepSql), sessionB.run(sweepSql)]);
    } finally {
      sessionA.close();
      sessionB.close();
    }
    assert.equal(resultA.stderr, "", `sweep A must not error: ${resultA.stderr}`);
    assert.equal(resultB.stderr, "", `sweep B must not error: ${resultB.stderr}`);
    assert.equal(purchasedCount(resultA) + purchasedCount(resultB), 1, "exactly one of the racing sweeps may buy the order");

    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE id = 710002"), "0");
    assert.equal(paymentCount(260), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_fulfilled_orders WHERE original_order_id = 710002"), "1");
    assert.equal(Number(botBalance(botId)), balanceBefore - 260 * 100);
  });
});
