"use strict";

// Server-side buyback schedule wiring: feature detection against older
// consoles, schedule form -> bridge payload mapping, permission-error
// surfacing, probe/run actions, and steering away from double automation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// Bridge payloads are built inside the jsdom window (a different realm), so
// deepEqual sees mismatched Object prototypes; JSON round-tripping normalizes.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function scheduleFixture(overrides = {}) {
  return {
    enabled: false,
    intervalMinutes: 30,
    exchangeId: "",
    priceMultiplier: 5,
    buybackPercent: 60,
    maxBuys: 500,
    lastRunAt: "",
    lastRunStatus: "",
    lastRunDetail: "",
    nextRunAt: "",
    ...overrides
  };
}

async function supportedHarness(schedule = scheduleFixture(), onScheduler = null) {
  const harness = await createHarness({
    onScheduler: onScheduler || (async (action) => {
      if (action === "scheduler.schedule.get") return schedule;
      throw new Error(`Unsupported addon action: ${action}`);
    })
  });
  await harness.waitFor(
    () => !harness.el("serverScheduleSection").hidden,
    { label: "server schedule section to appear" }
  );
  return harness;
}

test("older console keeps the section hidden and the in-page auto buyback untouched", async () => {
  // Default harness scheduler handler answers "Unsupported addon action",
  // exactly what a pre-scheduler console returns.
  const harness = await createHarness();
  await harness.flush();
  assert.equal(harness.el("serverScheduleSection").hidden, true, "section must stay hidden on older consoles");
  assert.equal(harness.el("autoBuyback").disabled, false, "in-page auto buyback must stay usable");
  assert.equal(harness.schedulerCalls("scheduler.schedule.get").length, 1, "feature detection probes schedule.get once");

  // The in-page loop still works end-to-end on older consoles.
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  harness.setCheckbox("autoBuyback", true);
  assert.match(harness.autoStatusText(), /Auto buyback armed/);
});

test("supported console shows the section and populates the saved schedule", async () => {
  const harness = await supportedHarness(scheduleFixture({
    enabled: true,
    intervalMinutes: 45,
    exchangeId: "9007199254740993",
    priceMultiplier: 7,
    buybackPercent: 55,
    maxBuys: 250,
    lastRunAt: "2026-07-24T00:00:00.000Z",
    lastRunStatus: "swept",
    lastRunDetail: "Bought 3 listings",
    nextRunAt: "2026-07-24T00:45:00.000Z"
  }));

  assert.equal(harness.el("serverScheduleEnabled").checked, true);
  assert.equal(harness.el("serverIntervalMinutes").value, "45");
  assert.equal(harness.el("serverPriceMultiplier").value, "7");
  assert.equal(harness.el("serverBuybackPercent").value, "55");
  assert.equal(harness.el("serverMaxBuys").value, "250");

  const status = harness.el("serverScheduleStatus").textContent;
  assert.match(status, /enabled, every 45 min on exchange 9007199254740993/);
  assert.match(status, /next run/);
  assert.match(status, /swept/);
  assert.match(status, /Bought 3 listings/);
});

test("saving maps the form to a schedule.set payload with a string exchangeId", async () => {
  let setPayload = null;
  const harness = await supportedHarness(scheduleFixture(), async (action, payload) => {
    if (action === "scheduler.schedule.get") return scheduleFixture();
    if (action === "scheduler.schedule.set") {
      setPayload = payload;
      return scheduleFixture({ ...payload.schedule, nextRunAt: "2026-07-24T01:00:00.000Z" });
    }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "9007199254740993" })]);

  harness.setValue("serverIntervalMinutes", 45);
  harness.setValue("serverPriceMultiplier", 7);
  harness.setValue("serverBuybackPercent", 55);
  harness.setValue("serverMaxBuys", 250);
  harness.el("serverScheduleEnabled").checked = true;
  harness.el("saveServerSchedule").click();
  await harness.waitFor(() => setPayload !== null, { label: "schedule.set call" });
  await harness.flush();

  assert.deepEqual(plain(setPayload), {
    schedule: {
      enabled: true,
      intervalMinutes: 45,
      priceMultiplier: 7,
      buybackPercent: 55,
      maxBuys: 250,
      exchangeId: "9007199254740993"
    }
  });
  assert.equal(typeof setPayload.schedule.exchangeId, "string", "exchangeId must be sent as a string");
  assert.match(harness.el("serverScheduleStatus").textContent, /enabled, every 45 min on exchange 9007199254740993/);
});

test("saving without an exchange selection omits exchangeId for a partial update", async () => {
  let setPayload = null;
  const harness = await createHarness({
    // Exchange discovery finds nothing, so the dropdown has no selection and
    // the saved exchangeId on the console must be left alone.
    onQuery: async () => ({ rows: [] }),
    onScheduler: async (action, payload) => {
      if (action === "scheduler.schedule.get") return scheduleFixture({ exchangeId: "42" });
      if (action === "scheduler.schedule.set") {
        setPayload = payload;
        return scheduleFixture({ exchangeId: "42", ...plain(payload.schedule) });
      }
      throw new Error(`Unsupported addon action: ${action}`);
    }
  });
  await harness.waitFor(
    () => !harness.el("serverScheduleSection").hidden,
    { label: "server schedule section to appear" }
  );

  harness.el("saveServerSchedule").click();
  await harness.waitFor(() => setPayload !== null, { label: "schedule.set call" });
  assert.equal("exchangeId" in setPayload.schedule, false, "omitted exchangeId keeps the saved value");
});

test("enabling without scheduler:server approval surfaces a permission hint", async () => {
  const harness = await supportedHarness(scheduleFixture(), async (action) => {
    if (action === "scheduler.schedule.get") return scheduleFixture();
    if (action === "scheduler.schedule.set") throw new Error("EDA Exchange Bot is not approved for scheduler:server permission.");
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.el("serverScheduleEnabled").checked = true;
  harness.el("saveServerSchedule").click();
  await harness.waitFor(
    () => harness.el("serverScheduleStatus").className.includes("error"),
    { label: "schedule.set permission error" }
  );
  const status = harness.el("serverScheduleStatus").textContent;
  assert.match(status, /not approved for scheduler:server permission/);
  assert.match(status, /Approve the scheduler:server permission/, "the error must include an actionable hint");
});

test("probe sends form overrides and reports the eligible count", async () => {
  let probePayload = null;
  const harness = await supportedHarness(scheduleFixture(), async (action, payload) => {
    if (action === "scheduler.schedule.get") return scheduleFixture();
    if (action === "scheduler.probe") {
      probePayload = payload;
      return { eligible: 4, exchangeId: payload.exchangeId, priceMultiplier: payload.priceMultiplier, buybackPercent: payload.buybackPercent, maxBuys: payload.maxBuys };
    }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.setValue("serverBuybackPercent", 50);
  harness.el("serverProbe").click();
  await harness.waitFor(() => probePayload !== null, { label: "scheduler.probe call" });
  await harness.flush();

  assert.deepEqual(plain(probePayload), { priceMultiplier: 5, buybackPercent: 50, maxBuys: 500, exchangeId: "77" });
  assert.equal("enabled" in probePayload, false, "probe overrides must not carry the enabled flag");
  assert.equal("intervalMinutes" in probePayload, false, "probe overrides must not carry the interval");
  const status = harness.el("serverScheduleStatus").textContent;
  assert.match(status, /4 eligible player listings on exchange 77 at 50% threshold/);
  assert.equal(harness.executedSql().length, 0, "probe must not run write SQL");
});

test("run sweep locks buttons like other writes and shows the result", async () => {
  const runGate = deferred();
  let runCalls = 0;
  const harness = await supportedHarness(scheduleFixture({ exchangeId: "77" }), async (action) => {
    if (action === "scheduler.schedule.get") return scheduleFixture({ exchangeId: "77" });
    if (action === "scheduler.run") {
      runCalls += 1;
      await runGate.promise;
      return {
        status: "swept",
        eligible: 3,
        purchased: 3,
        totalUnits: 120,
        totalSolari: 45000,
        detail: "Bought 3 listings",
        schedule: scheduleFixture({ exchangeId: "77", lastRunAt: "2026-07-24T00:00:00.000Z", lastRunStatus: "swept", lastRunDetail: "Bought 3 listings" })
      };
    }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.el("serverRun").click();
  await harness.waitFor(() => runCalls === 1, { label: "scheduler.run to start" });

  // First line of defense: every button is disabled while the run is in
  // flight, exactly like the SQL write path.
  assert.equal(harness.el("buySweep").disabled, true, "buttons must be disabled during a server-side run");
  assert.equal(harness.el("serverRun").disabled, true);

  // Second line of defense: the shared writeInProgress guard refuses a manual
  // sweep even if the click gets through.
  harness.el("buySweep").disabled = false;
  harness.el("buySweep").click();
  await harness.flush();
  assert.equal(harness.statusText(), "Another write is already in progress.");
  assert.equal(harness.executedSql().length, 0, "no SQL write may start during a server-side run");

  runGate.resolve();
  await harness.waitFor(
    () => harness.el("serverScheduleStatus").textContent.includes("sweep finished"),
    { label: "server-side sweep completion" }
  );
  const status = harness.el("serverScheduleStatus").textContent;
  assert.match(status, /bought 3 listings \(120 units, 45,000 Solari\)/i);
  assert.match(harness.el("resultOutput").textContent, /"purchased": 3/);
  assert.equal(harness.el("buySweep").disabled, false, "buttons must be re-enabled after the run");
  assert.equal(runCalls, 1);
});

test("run sweep refuses to start while a manual SQL write is in flight", async () => {
  const executeGate = deferred();
  let runCalls = 0;
  const harness = await supportedHarness(scheduleFixture({ exchangeId: "77" }), async (action) => {
    if (action === "scheduler.schedule.get") return scheduleFixture({ exchangeId: "77" });
    if (action === "scheduler.run") { runCalls += 1; return { status: "idle", eligible: 0 }; }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  harness.onExecute = async () => { await executeGate.promise; return { rows: [] }; };

  harness.el("buySweep").click();
  await harness.waitFor(() => harness.executedSql().length === 1, { label: "manual sweep write to start" });

  harness.el("serverRun").disabled = false;
  harness.el("serverRun").click();
  await harness.flush();
  assert.equal(runCalls, 0, "the server run must not start during a manual write");
  assert.match(harness.el("serverScheduleStatus").textContent, /Another write is already in progress/);

  executeGate.resolve();
  await harness.waitFor(() => harness.statusText().includes("complete"), { label: "manual sweep completion" });
});

test("an enabled server schedule turns off and disables the in-page auto buyback", async () => {
  let schedule = scheduleFixture({ exchangeId: "77" });
  const harness = await supportedHarness(schedule, async (action) => {
    if (action === "scheduler.schedule.get") return schedule;
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.setCheckbox("autoBuyback", true);
  assert.equal(harness.el("autoBuyback").checked, true);

  // The console reports the schedule as enabled (e.g. another admin enabled
  // it); a status refresh must steer this page away from double automation.
  schedule = scheduleFixture({ exchangeId: "77", enabled: true, nextRunAt: "2026-07-24T01:00:00.000Z" });
  harness.el("refreshServerSchedule").click();
  await harness.waitFor(() => harness.el("autoBuyback").disabled, { label: "in-page auto buyback to be disabled" });
  assert.equal(harness.el("autoBuyback").checked, false, "in-page auto buyback must be unchecked");
  assert.match(harness.autoStatusText(), /server-side schedule runs sweeps unattended/);

  // Disabling the server schedule hands the checkbox back to the admin.
  schedule = scheduleFixture({ exchangeId: "77", enabled: false });
  harness.el("refreshServerSchedule").click();
  await harness.waitFor(() => !harness.el("autoBuyback").disabled, { label: "in-page auto buyback to be re-enabled" });
  assert.equal(harness.el("autoBuyback").checked, false, "the checkbox stays unchecked until the admin re-arms it");
});

test("status poll refreshes quietly without touching form edits", async () => {
  let schedule = scheduleFixture({ exchangeId: "77" });
  const harness = await supportedHarness(schedule, async (action) => {
    if (action === "scheduler.schedule.get") return schedule;
    throw new Error(`Unsupported addon action: ${action}`);
  });

  const before = harness.schedulerCalls("scheduler.schedule.get").length;
  harness.setValue("serverIntervalMinutes", 120);
  schedule = scheduleFixture({ exchangeId: "77", lastRunAt: "2026-07-24T00:00:00.000Z", lastRunStatus: "idle", lastRunDetail: "Nothing eligible" });

  // The poll tick shares the harness interval registry with the auto-buyback
  // tick; firing all callbacks simulates the timers going off.
  harness.autoTick();
  await harness.waitFor(
    () => harness.schedulerCalls("scheduler.schedule.get").length > before,
    { label: "poll refresh" }
  );
  await harness.flush();
  assert.match(harness.el("serverScheduleStatus").textContent, /Nothing eligible/);
  assert.equal(harness.el("serverIntervalMinutes").value, "120", "a quiet poll must not stomp form edits");
});
