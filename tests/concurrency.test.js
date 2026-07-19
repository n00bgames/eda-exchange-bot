"use strict";

// Manual vs automatic buyback concurrency: only one write may be in flight,
// and the auto scheduler must skip ticks while a manual write runs.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function armedHarness() {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  harness.setCheckbox("autoBuyback", true);
  return harness;
}

test("manual sweep during an auto sweep is refused, only one write runs", async () => {
  const harness = await armedHarness();

  const executeGate = deferred();
  let executeCalls = 0;
  harness.onQuery = async ({ query }) => {
    if (query.includes("eligible_orders")) return { rows: [{ eligible_orders: "3" }] };
    return { rows: [exchangeRow({ exchange_id: "77" })] };
  };
  harness.onExecute = async () => { executeCalls += 1; await executeGate.promise; return { rows: [] }; };

  // Fire the auto tick one interval after arming; the sweep blocks on the
  // gated database.execute call.
  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => executeCalls === 1, { label: "auto sweep write to start" });

  // First line of defense: every button is disabled while a write runs, so a
  // click on the manual sweep does nothing.
  assert.equal(harness.el("buySweep").disabled, true, "buttons must be disabled during the auto write");
  harness.el("buySweep").click();
  await harness.flush();
  assert.equal(executeCalls, 1, "a click on the disabled button must not start a write");

  // Second line of defense: even if the click gets through (e.g. devtools),
  // the writeInProgress guard refuses the manual sweep before any SQL runs.
  harness.el("buySweep").disabled = false;
  harness.el("buySweep").click();
  await harness.flush();
  assert.equal(harness.statusText(), "Another write is already in progress.");
  assert.equal(executeCalls, 1, "the manual sweep must not start a second write");

  executeGate.resolve();
  await harness.waitFor(() => harness.autoStatusText().includes("sweep finished"), { label: "auto sweep completion" });
  assert.equal(executeCalls, 1);
});

test("auto tick during a manual sweep is skipped entirely", async () => {
  const harness = await armedHarness();

  const executeGate = deferred();
  let executeCalls = 0;
  let eligibilityChecks = 0;
  harness.onQuery = async ({ query }) => {
    if (query.includes("eligible_orders")) { eligibilityChecks += 1; return { rows: [{ eligible_orders: "5" }] }; }
    return { rows: [exchangeRow({ exchange_id: "77" })] };
  };
  harness.onExecute = async () => { executeCalls += 1; await executeGate.promise; return { rows: [] }; };

  // Start a manual sweep that blocks on the write.
  harness.el("buySweep").click();
  await harness.waitFor(() => executeCalls === 1, { label: "manual sweep write to start" });

  // The auto interval elapses while the manual write is still running: the
  // tick must not even run its eligibility probe.
  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.flush();
  assert.equal(eligibilityChecks, 0, "auto tick must be skipped while a manual write runs");
  assert.equal(executeCalls, 1);

  executeGate.resolve();
  await harness.waitFor(() => harness.statusText().includes("complete"), { label: "manual sweep completion" });
  assert.equal(executeCalls, 1, "no queued auto sweep may fire after the manual write finishes");
});

test("auto sweep skips the write when nothing is eligible", async () => {
  const harness = await armedHarness();

  let executeCalls = 0;
  harness.onQuery = async ({ query }) => {
    if (query.includes("eligible_orders")) return { rows: [{ eligible_orders: "0" }] };
    return { rows: [exchangeRow({ exchange_id: "77" })] };
  };
  harness.onExecute = async () => { executeCalls += 1; return { rows: [] }; };

  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => harness.autoStatusText().includes("nothing eligible"), { label: "idle auto tick" });
  assert.equal(executeCalls, 0, "no write (and no backup) when nothing is eligible");
});

test("arming auto buyback never fires immediately", async () => {
  const harness = await armedHarness();
  let eligibilityChecks = 0;
  harness.onQuery = async ({ query }) => {
    if (query.includes("eligible_orders")) { eligibilityChecks += 1; return { rows: [{ eligible_orders: "9" }] }; }
    return { rows: [exchangeRow({ exchange_id: "77" })] };
  };
  harness.autoTick();
  await harness.flush();
  assert.equal(eligibilityChecks, 0, "first run must wait one full interval after arming");
});
