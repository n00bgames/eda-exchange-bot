"use strict";

// jsdom harness that loads the real addon page (web/index.html + web/addon.js)
// with a mock RedBlink bridge, so tests drive the same code paths the console
// runs: DOM events, localStorage, confirm prompts, and bridge SQL.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const webDir = path.join(__dirname, "..", "..", "web");
const addonSource = fs.readFileSync(path.join(webDir, "addon.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8");

const TEST_SEED_PLAN = {
  generated_at: "2026-01-01T00:00:00+00:00",
  panel_version: "test-fixture",
  price_multiplier: 5,
  market_bot_class: "Revy",
  rows: [
    { template_id: "TestRifle", display_name: "Test Rifle", kind: "equippable", stack_size: 1, price: 5000, category_mask: 16777216, category_depth: 1, quality_level: 0, listings: 2 },
    { template_id: "TestSchematic", display_name: "Test Schematic", kind: "schematic", stack_size: 1, price: 10000, category_mask: 16975104, category_depth: 3, quality_level: 0, listings: 2 },
    { template_id: "TestOre", display_name: "Test Ore", kind: "resource", stack_size: 100, price: 500, category_mask: 84017152, category_depth: 2, quality_level: 0, listings: 1 },
    // Grade-2 row with an already grade-adjusted price (10000 * 1.25), like
    // the bundled T6 augment rows; the buyback plan must normalize it back.
    { template_id: "TestAugment", display_name: "Test Augment", kind: "equippable", stack_size: 1, price: 12500, category_mask: 33554432, category_depth: 3, quality_level: 2, listings: 1 }
  ],
  unsafe_template_ids: ["UnsafeThing"]
};

function bundledSeedPlan() {
  return JSON.parse(fs.readFileSync(path.join(webDir, "market-seed-plan.json"), "utf8"));
}

function exchangeRow(overrides = {}) {
  return {
    exchange_id: "1",
    is_global: false,
    access_point_count: "1",
    order_count: "0",
    bot_order_count: "0",
    npc_flag_order_count: "0",
    player_order_count: "0",
    ...overrides
  };
}

// Let queued microtasks and immediate callbacks settle.
async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const harnessProto = {
  flush,
  async waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await flush(2);
    }
    throw new Error(`Timed out waiting for ${label}`);
  },
  el(id) { return this.document.getElementById(id); },
  statusText() { return this.el("status").textContent; },
  autoStatusText() { return this.el("autoStatus").textContent; },
  setCheckbox(id, checked) {
    const box = this.el(id);
    box.checked = checked;
    box.dispatchEvent(new this.window.Event("change", { bubbles: true }));
  },
  setValue(id, value) {
    const input = this.el(id);
    input.value = String(value);
    input.dispatchEvent(new this.window.Event("change", { bubbles: true }));
  },
  selectedExchangeId() { return this.el("exchangeId").value; },
  exchangeOptionValues() {
    return Array.from(this.el("exchangeId").options).map((option) => option.value).filter(Boolean);
  },
  async loadExchangesWithRows(rows) {
    // Answer the exchange-discovery query with the given rows; delegate any
    // other read (e.g. the auto-buyback eligibility probe) to the handler the
    // test installed.
    const previous = this.onQuery;
    this.onQuery = async (payload) => {
      if (String(payload?.query || "").includes("known_exchanges")) return { rows };
      return previous(payload);
    };
    this.el("refreshExchanges").click();
    await this.waitFor(
      () => this.exchangeOptionValues().length > 0 || this.statusText().includes("failed"),
      { label: "exchange options" }
    );
    await this.flush();
  },
  executedSql() {
    return this.bridgeCalls.filter((call) => call.action === "database.execute").map((call) => call.query);
  },
  schedulerCalls(action = null) {
    return this.bridgeCalls.filter((call) => (action ? call.action === action : String(call.action).startsWith("scheduler.")));
  },
  async clickAndCaptureSql(buttonId) {
    const before = this.executedSql().length;
    this.el(buttonId).click();
    await this.waitFor(
      () => this.executedSql().length > before || this.el("status").className.includes("error"),
      { label: `write from #${buttonId}` }
    );
    await this.flush();
    const executed = this.executedSql();
    return executed.length > before ? executed[executed.length - 1] : null;
  },
  autoTick() {
    for (const fn of this.intervalCallbacks) fn();
  }
};

async function createHarness(options = {}) {
  const seedPlan = options.seedPlan || TEST_SEED_PLAN;
  const dom = new JSDOM(indexHtml, {
    url: "https://console.local/addons/eda-exchange-bot/web/index.html",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;

  // The addon rejects bridge calls when it is not iframed; pretend a parent
  // console page exists.
  Object.defineProperty(window, "parent", { get: () => ({}), configurable: true });

  const harness = Object.create(harnessProto);
  Object.assign(harness, {
    window,
    document: window.document,
    bridgeCalls: [],
    confirmMessages: [],
    confirmResponse: true,
    intervalCallbacks: [],
    // Handlers may be replaced per-test. They may return promises.
    onQuery: options.onQuery || (async () => ({ rows: [exchangeRow()] })),
    onExecute: options.onExecute || (async () => ({ rows: [] })),
    // scheduler.* actions default to what a pre-scheduler console answers, so
    // existing tests exercise the feature-detection fallback path.
    onScheduler: options.onScheduler || (async (action) => { throw new Error(`Unsupported addon action: ${action}`); })
  });

  window.DuneAddon = {
    request(action, payload) {
      harness.bridgeCalls.push({ action, payload, query: payload?.query });
      try {
        if (action === "database.query") return Promise.resolve(harness.onQuery(payload));
        if (action === "database.execute") return Promise.resolve(harness.onExecute(payload));
        if (String(action).startsWith("scheduler.")) return Promise.resolve(harness.onScheduler(action, payload));
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.reject(new Error(`Unexpected bridge action: ${action}`));
    }
  };

  window.confirm = (message) => {
    harness.confirmMessages.push(message);
    return harness.confirmResponse;
  };

  window.fetch = async (url) => {
    if (String(url).includes("market-seed-plan.json")) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(seedPlan)) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Capture the auto-buyback interval callback so tests can fire ticks
  // deterministically instead of waiting 15 real seconds.
  window.setInterval = (fn) => {
    harness.intervalCallbacks.push(fn);
    return harness.intervalCallbacks.length;
  };

  // Controllable clock for scheduler tests.
  let timeOffset = 0;
  const realNow = Date.now;
  window.Date.now = () => realNow() + timeOffset;
  harness.advanceTime = (ms) => { timeOffset += ms; };

  window.eval(addonSource);
  await harness.waitFor(
    () => harness.statusText().includes("Preview ready") || harness.el("status").className.includes("error"),
    { label: "initial seed plan load" }
  );
  await harness.flush();

  return harness;
}

module.exports = { createHarness, exchangeRow, TEST_SEED_PLAN, bundledSeedPlan, flush };
