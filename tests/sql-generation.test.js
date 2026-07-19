"use strict";

// Bug 2 regression tests plus buyback SQL generation checks, asserted on the
// SQL text the addon hands to the bridge. Runtime behavior against a real
// PostgreSQL server is covered by the db-*.test.js files.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

const EXCHANGE_ID = "4242";

async function harnessWithExchange() {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: EXCHANGE_ID })]);
  return harness;
}

test("seeding cleanup is scoped to owner AND selected exchange", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_sell_orders WHERE order_id IN \(SELECT id FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id\);/);
  assert.match(sql, /WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id AND item_id IS NOT NULL;/);
  // The unscoped delete from the reported bug must be gone.
  assert.ok(!/WHERE owner_id = v_owner_id\s*;/.test(sql), "cleanup must not delete across all exchanges");
  // The cleanup block resolves the same selected exchange id before deleting.
  assert.ok(sql.includes(`v_exchange_id := ${EXCHANGE_ID};`), "cleanup must resolve the selected exchange before deleting");
});

test("unchecking clear-existing removes the cleanup block entirely", async () => {
  const harness = await harnessWithExchange();
  harness.setCheckbox("clearExisting", false);
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql, `seed write did not run: ${harness.statusText()}`);
  assert.ok(!sql.includes("DELETE FROM"), "no deletes expected when clear-existing is off");
});

test("global clear confirmation states it affects all exchanges", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("clearNpc");
  assert.ok(sql, `clear write did not run: ${harness.statusText()}`);
  const confirmMessage = harness.confirmMessages.at(-1);
  assert.match(confirmMessage, /ALL exchanges/, `confirmation must warn about all exchanges: ${confirmMessage}`);
  // The global action intentionally stays unscoped: no exchange filter.
  assert.ok(!sql.includes("exchange_id ="), "global clear intentionally has no exchange filter");
});

test("declining the global clear confirmation runs nothing", async () => {
  const harness = await harnessWithExchange();
  harness.confirmResponse = false;
  harness.el("clearNpc").click();
  await harness.flush();
  assert.equal(harness.executedSql().length, 0);
});

test("buyback SQL: plan prices, grade normalization, and threshold rounding", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);

  // Threshold 60%: ceil(price * 60 / 100). TestAugment is bundled at grade 2
  // with a grade-adjusted price (12500 = 10000 * 1.25) and must be normalized
  // back to its grade-0 price before the threshold applies.
  assert.ok(sql.includes("('TestRifle',3000)"), "TestRifle: 5000 * 60% = 3000");
  assert.ok(sql.includes("('TestSchematic',6000)"), "TestSchematic: 10000 * 60% = 6000");
  assert.ok(sql.includes("('TestOre',300)"), "TestOre: 500 * 60% = 300");
  assert.ok(sql.includes("('TestAugment',6000)"), "TestAugment: normalized 10000 * 60% = 6000");
});

test("buyback SQL: payment records are per-unit, never-expiring, seller-owned", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);

  // Payment entry: owned by the seller, per-unit item_price (the game
  // multiplies by stack size), sentinel expiry, not an NPC order.
  assert.ok(sql.includes(
    "VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, 999999999, 1.0, 1.0, rec.item_price, 0, 0, FALSE)"
  ), "payment insert must be per-unit with the never-expires sentinel");
  assert.ok(!sql.includes("rec.item_price * rec.actual_stack) RETURNING id INTO v_log_order_id"), "payment must not pre-multiply by stack size");
  // Fulfilled-order audit row references the bought order.
  assert.match(sql, /INSERT INTO dune\.dune_exchange_fulfilled_orders \(order_id, source_order_id, completion_type, stack_size, original_order_id\)/);
  // Sweep only touches the selected exchange and player orders.
  assert.ok(sql.includes(`o.exchange_id = ${EXCHANGE_ID} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id`));
  // Max buys limit applies.
  assert.match(sql, /LIMIT 500 LOOP/);
});

test("buyback SQL: changing threshold and max buys is reflected", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPercent", 50);
  harness.setValue("maxBuys", 25);
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql.includes("('TestOre',250)"), "TestOre: 500 * 50% = 250");
  assert.match(sql, /LIMIT 25 LOOP/);
  assert.match(sql, /VALUES \(v_purchased, v_units, v_solari, 50, 25\)/);
});
