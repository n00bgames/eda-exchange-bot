(function () {
  "use strict";

  const statusEl = document.getElementById("status");
  const autoStatusEl = document.getElementById("autoStatus");
  const summaryEl = document.getElementById("summary");
  const tableEl = document.getElementById("table");
  const resultEl = document.getElementById("resultOutput");
  const filterEl = document.getElementById("filter");
  const kindFilterEl = document.getElementById("kindFilter");
  const multiplierEl = document.getElementById("priceMultiplier");
  const thresholdEl = document.getElementById("buybackPercent");
  const maxBuysEl = document.getElementById("maxBuys");
  const exchangeIdEl = document.getElementById("exchangeId");
  const manualExchangeIdEl = document.getElementById("manualExchangeId");
  const clearExistingEl = document.getElementById("clearExisting");
  const schematicGradesEl = document.getElementById("schematicGrades");
  const schematicPerGradeEl = document.getElementById("schematicPerGrade");
  const materialListingsEl = document.getElementById("materialListings");
  const autoBuybackEl = document.getElementById("autoBuyback");
  const autoBuybackIntervalEl = document.getElementById("autoBuybackInterval");

  let payload = null;
  let renderedRows = [];
  let exchangesLoaded = false;
  let writeInProgress = false;
  let nextAutoRunAt = 0;
  let autoRunning = false;

  const rememberedExchangeStorageKey = "eda-exchange-bot.remembered-exchanges";
  const settingsStorageKey = "eda-exchange-bot.settings";

  // Quality-grade price multipliers for grades 0-5, matching Easy Dune Admin's
  // market bot defaults (internal/marketbot config.go GradeMultipliers).
  const GRADE_MULTIPLIERS = [1.0, 1.0, 1.25, 1.5, 1.75, 2.0];
  const GRADE_MULTIPLIER_SQL = "(ARRAY[1.0,1.0,1.25,1.5,1.75,2.0])[LEAST(GREATEST(COALESCE(o.quality_level, 0), 0), 5) + 1]";

  // Sentinel expiration used by EDA's market bot for seller "Take Solari"
  // payment entries. The game server's dune_exchange_expire_orders proc runs
  // every ~5 minutes and purges past-dated orders; a payment entry must never
  // expire or the seller's item is consumed with no Solari paid out.
  const PAYMENT_SENTINEL_EXPIRY = 999999999;

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function sqlLiteral(value) { return "'" + String(value ?? "").replaceAll("'", "''") + "'"; }
  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : String(value ?? "");
  }
  function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) return fallback;
    return number;
  }
  function roundPrice(value) {
    const number = Math.max(1, Number(value) || 1);
    let step = 1;
    if (number >= 1000000) step = 10000;
    else if (number >= 100000) step = 1000;
    else if (number >= 10000) step = 100;
    else if (number >= 1000) step = 10;
    return Math.max(1, Math.round(number / step) * step);
  }
  function gradedPrice(basePrice, grade) {
    const mult = GRADE_MULTIPLIERS[clampInteger(grade, 0, 0, 5)] || 1.0;
    return roundPrice(basePrice * mult);
  }
  function currentMultiplier() { return clampInteger(multiplierEl.value, payload?.price_multiplier || 5, 1, 100); }
  function currentThreshold() { return clampInteger(thresholdEl.value, 60, 1, 100); }
  function currentMaxBuys() { return clampInteger(maxBuysEl.value, 500, 1, 5000); }
  function currentSchematicPerGrade() { return clampInteger(schematicPerGradeEl.value, 2, 1, 20); }
  function currentMaterialListings() { return clampInteger(materialListingsEl.value, 4, 1, 50); }
  function currentAutoIntervalMinutes() { return clampInteger(autoBuybackIntervalEl.value, 30, 10, 1440); }

  function currentExchangeIdValue() {
    const raw = String(exchangeIdEl.value || "").trim();
    if (!raw) throw new Error("Choose an exchange before running this action.");
    const id = clampInteger(Number(raw), 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new Error("Exchange selection is invalid.");
    return id;
  }
  function currentExchangeIdSql() {
    return `v_exchange_id := ${currentExchangeIdValue()};`;
  }

  function persistSettings() {
    try {
      localStorage.setItem(settingsStorageKey, JSON.stringify({
        priceMultiplier: multiplierEl.value,
        buybackPercent: thresholdEl.value,
        maxBuys: maxBuysEl.value,
        clearExisting: clearExistingEl.checked,
        schematicGrades: schematicGradesEl.checked,
        schematicPerGrade: schematicPerGradeEl.value,
        materialListings: materialListingsEl.value,
        autoBuyback: autoBuybackEl.checked,
        autoBuybackInterval: autoBuybackIntervalEl.value
      }));
    } catch { /* storage unavailable; settings just aren't remembered */ }
  }
  function restoreSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(settingsStorageKey) || "null"); } catch { saved = null; }
    if (!saved || typeof saved !== "object") return;
    if (saved.priceMultiplier != null) multiplierEl.value = String(saved.priceMultiplier);
    if (saved.buybackPercent != null) thresholdEl.value = String(saved.buybackPercent);
    if (saved.maxBuys != null) maxBuysEl.value = String(saved.maxBuys);
    if (typeof saved.clearExisting === "boolean") clearExistingEl.checked = saved.clearExisting;
    if (typeof saved.schematicGrades === "boolean") schematicGradesEl.checked = saved.schematicGrades;
    if (saved.schematicPerGrade != null) schematicPerGradeEl.value = String(saved.schematicPerGrade);
    if (saved.materialListings != null) materialListingsEl.value = String(saved.materialListings);
    if (typeof saved.autoBuyback === "boolean") autoBuybackEl.checked = saved.autoBuyback;
    if (saved.autoBuybackInterval != null) autoBuybackIntervalEl.value = String(saved.autoBuybackInterval);
  }

  function rememberedExchangeIds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(rememberedExchangeStorageKey) || "[]");
      return Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
    } catch {
      return [];
    }
  }
  function saveRememberedExchangeIds(ids) {
    const normalized = Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
    localStorage.setItem(rememberedExchangeStorageKey, JSON.stringify(normalized));
  }
  function rememberExchangeId(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1) throw new Error("Exchange ID must be a positive whole number.");
    saveRememberedExchangeIds([...rememberedExchangeIds(), numericId]);
    return numericId;
  }

  function requestBridge(action, requestPayload = {}) {
    if (window.parent === window) {
      return Promise.reject(new Error("Open this addon inside RedBlink Dune Docker Console to use bridge-backed write actions."));
    }
    if (!window.DuneAddon || typeof window.DuneAddon.request !== "function") {
      return Promise.reject(new Error("RedBlink addon bridge helper is not available."));
    }
    return window.DuneAddon.request(action, requestPayload);
  }

  function priceForRow(row) {
    const sourceMultiplier = Math.max(1, Number(payload?.price_multiplier || 1));
    return roundPrice((Number(row.price) / sourceMultiplier) * currentMultiplier());
  }

  // Base rows: bundled plan rows re-priced to the current multiplier, before
  // schematic-grade expansion and material scaling.
  function baseRowsForCurrentMultiplier() {
    if (!payload) return [];
    return (payload.rows || []).map((row) => ({ ...row, price: priceForRow(row) }));
  }

  // Expanded rows: what actually gets previewed and seeded.
  // - Schematics fan out to quality grades 1-5 (configurable listings per
  //   grade, default 2 each) with grade-multiplied prices, replacing the
  //   bundled grade-0 schematic row.
  // - Materials (resource rows) get a configurable listing count each
  //   (default 4) instead of the bundled single listing.
  function rowsForCurrentMultiplier() {
    const base = baseRowsForCurrentMultiplier();
    const perGrade = currentSchematicPerGrade();
    const materialEach = currentMaterialListings();
    const expandGrades = schematicGradesEl.checked;
    const out = [];
    for (const row of base) {
      if (row.kind === "schematic" && expandGrades) {
        for (let grade = 1; grade <= 5; grade++) {
          out.push({ ...row, quality_level: grade, price: gradedPrice(row.price, grade), listings: perGrade });
        }
        continue;
      }
      if (row.kind === "resource") {
        out.push({ ...row, listings: Math.max(Number(row.listings || 1), materialEach) });
        continue;
      }
      out.push(row);
    }
    return out;
  }

  function renderSummary(rows = rowsForCurrentMultiplier()) {
    const totals = rows.reduce((acc, row) => {
      acc.listings += Number(row.listings || 0);
      acc.unique += 1;
      acc[`${row.kind}_listings`] = (acc[`${row.kind}_listings`] || 0) + Number(row.listings || 0);
      if (row.kind === "resource") acc.resource_units += Number(row.stack_size || 0) * Number(row.listings || 0);
      return acc;
    }, { listings: 0, unique: 0, resource_units: 0 });
    const metrics = [
      ["Listings", totals.listings],
      ["Unique rows", totals.unique],
      ["Resources", totals.resource_listings || 0],
      ["Resource units", totals.resource_units],
      ["Schematics", totals.schematic_listings || 0],
      ["Equippables", totals.equippable_listings || 0],
      ["Ammunition", totals.ammunition_listings || 0],
      ["Consumables", totals.consumable_listings || 0],
      ["Multiplier", `${currentMultiplier()}x`],
    ];
    summaryEl.innerHTML = metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(formatNumber(value))}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderKinds(rows) {
    const current = kindFilterEl.value;
    const kinds = Array.from(new Set(rows.map(row => row.kind))).sort();
    kindFilterEl.innerHTML = `<option value="">All kinds</option>${kinds.map(kind => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`).join("")}`;
    kindFilterEl.value = kinds.includes(current) ? current : "";
  }

  function visibleRows() {
    const query = filterEl.value.trim().toLowerCase();
    const kind = kindFilterEl.value;
    return renderedRows.filter(row => {
      if (kind && row.kind !== kind) return false;
      if (!query) return true;
      return [row.template_id, row.display_name, row.kind, row.category_mask, row.category_depth, row.price, row.stack_size, row.quality_level].some(value => String(value ?? "").toLowerCase().includes(query));
    });
  }

  function renderRows() {
    const rows = visibleRows();
    if (!rows.length) { tableEl.innerHTML = "<p>No seed rows match the current filter.</p>"; return; }
    const shown = rows.slice(0, 250);
    tableEl.innerHTML = `<table><thead><tr><th>Name</th><th>Template</th><th>Kind</th><th>Grade</th><th>Listings</th><th>Stack</th><th>Price</th><th>Mask</th><th>Depth</th></tr></thead><tbody>${shown.map(row => `<tr><td>${escapeHtml(row.display_name)}</td><td>${escapeHtml(row.template_id)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatNumber(row.quality_level || 0))}</td><td>${escapeHtml(formatNumber(row.listings))}</td><td>${escapeHtml(formatNumber(row.stack_size))}</td><td>${escapeHtml(formatNumber(row.price))}</td><td>${escapeHtml(row.category_mask)}</td><td>${escapeHtml(row.category_depth)}</td></tr>`).join("")}</tbody></table>`;
    if (rows.length > shown.length) tableEl.insertAdjacentHTML("beforeend", `<p>Showing first ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} matching unique rows. Narrow the filter for more detail.</p>`);
  }

  function renderExchangeOptions(rows, preferredId = exchangeIdEl.value) {
    const discovered = (rows || [])
      .map((row) => ({
        id: Number(row.exchange_id),
        orderCount: Number(row.order_count || 0),
        botOrders: Number(row.bot_order_count || 0),
        npcFlagOrders: Number(row.npc_flag_order_count || 0),
        playerOrders: Number(row.player_order_count || 0),
        accessPoints: Number(row.access_point_count || 0),
        isGlobal: Boolean(row.is_global),
        source: "live"
      }))
      .filter((row) => Number.isInteger(row.id) && row.id > 0);

    saveRememberedExchangeIds([...rememberedExchangeIds(), ...discovered.map((exchange) => exchange.id)]);

    const byId = new Map(discovered.map((exchange) => [exchange.id, exchange]));
    for (const id of rememberedExchangeIds()) {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          orderCount: 0,
          botOrders: 0,
          npcFlagOrders: 0,
          playerOrders: 0,
          accessPoints: 0,
          isGlobal: false,
          source: "remembered"
        });
      }
    }

    // Exchanges with real access points come first: those are the exchanges
    // players actually reach in-game (EDA market bot exchange-detection fix).
    const options = Array.from(byId.values())
      .sort((left, right) => {
        const leftHasAp = left.accessPoints > 0 ? 0 : 1;
        const rightHasAp = right.accessPoints > 0 ? 0 : 1;
        if (leftHasAp !== rightHasAp) return leftHasAp - rightHasAp;
        if (left.isGlobal !== right.isGlobal) return left.isGlobal ? 1 : -1;
        return left.id - right.id;
      });

    if (!options.length) {
      exchangeIdEl.innerHTML = `<option value="">No exchanges found</option>`;
      exchangesLoaded = false;
      return;
    }

    exchangeIdEl.innerHTML = options.map((exchange) => {
      const labelParts = [
        exchange.isGlobal ? "Global" : `Exchange ${exchange.id}`,
        `ID ${exchange.id}`,
        `${exchange.accessPoints.toLocaleString()} access points`,
        `${exchange.orderCount.toLocaleString()} orders`,
        `${exchange.botOrders.toLocaleString()} bot`,
        `${exchange.playerOrders.toLocaleString()} player`,
        exchange.source === "remembered" ? "remembered/manual" : "live"
      ];
      return `<option value="${exchange.id}">${escapeHtml(labelParts.join(" | "))}</option>`;
    }).join("");
    const preferred = options.find((exchange) => String(exchange.id) === String(preferredId || ""));
    const withAccessPoint = options.find((exchange) => exchange.accessPoints > 0 && !exchange.isGlobal);
    const nonGlobal = options.find((exchange) => !exchange.isGlobal);
    const global = options.find((exchange) => exchange.isGlobal);
    exchangeIdEl.value = String((preferred || withAccessPoint || nonGlobal || global || options[0]).id);
    exchangesLoaded = true;
  }

  async function loadExchanges() {
    exchangeIdEl.innerHTML = `<option value="">Loading exchanges...</option>`;
    try {
      const result = await requestBridge("database.query", {
        query: `WITH global_exchange AS (
    SELECT dune.get_dune_exchange_id('Global')::bigint AS exchange_id
),
known_exchanges AS (
    SELECT exchange_id FROM dune.dune_exchange_orders
    UNION
    SELECT exchange_id FROM dune.dune_exchange_accesspoints
    UNION
    SELECT exchange_id FROM global_exchange
)
SELECT
    k.exchange_id::text AS exchange_id,
    (k.exchange_id = (SELECT exchange_id FROM global_exchange)) AS is_global,
    ap.access_point_count::text AS access_point_count,
    COUNT(o.id)::text AS order_count,
    COUNT(o.id) FILTER (WHERE o.owner_id = bot.owner_id OR o.is_npc_order = TRUE)::text AS bot_order_count,
    COUNT(o.id) FILTER (WHERE o.is_npc_order = TRUE)::text AS npc_flag_order_count,
    COUNT(o.id) FILTER (WHERE COALESCE(o.is_npc_order, FALSE) = FALSE AND (bot.owner_id IS NULL OR o.owner_id <> bot.owner_id))::text AS player_order_count
FROM known_exchanges k
LEFT JOIN dune.dune_exchange_orders o ON o.exchange_id = k.exchange_id
LEFT JOIN LATERAL (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
) bot ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS access_point_count FROM dune.dune_exchange_accesspoints a WHERE a.exchange_id = k.exchange_id
) ap ON TRUE
GROUP BY k.exchange_id, ap.access_point_count
ORDER BY is_global ASC, k.exchange_id ASC;`
      });
      renderExchangeOptions(result.rows || []);
    } catch (error) {
      exchangeIdEl.innerHTML = `<option value="">Exchange lookup failed</option>`;
      exchangesLoaded = false;
      statusEl.className = "status error";
      statusEl.textContent = `Exchange lookup failed: ${error.message || String(error)}`;
    }
  }

  function addManualExchange() {
    try {
      const id = rememberExchangeId(manualExchangeIdEl.value);
      manualExchangeIdEl.value = "";
      renderExchangeOptions([], id);
      statusEl.className = "status ok";
      statusEl.textContent = `Remembered exchange ID ${id}. It can now be selected even with no current orders.`;
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
    }
  }

  function refreshPreview() {
    if (!payload) return;
    renderedRows = rowsForCurrentMultiplier();
    renderSummary(renderedRows);
    renderKinds(renderedRows);
    renderRows();
    statusEl.className = "status";
    statusEl.textContent = `Preview ready from EDA ${payload.panel_version}; ${renderedRows.length.toLocaleString()} unique rows at ${currentMultiplier()}x.`;
  }

  function valuesForSeedRows(rows) {
    return rows.map(row => `(${[sqlLiteral(row.template_id), Number(row.stack_size), Number(row.price), Number(row.category_mask), Number(row.category_depth), Number(row.quality_level || 0), sqlLiteral(row.kind), Number(row.listings || 1)].join(",")})`).join(",\n");
  }

  function buildSeedSql() {
    const rows = rowsForCurrentMultiplier();
    const valuesSql = valuesForSeedRows(rows);
    const clearSql = clearExistingEl.checked ? `
DO $$
DECLARE
    v_owner_id BIGINT;
    v_item_ids BIGINT[];
BEGIN
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NOT NULL THEN
        SELECT ARRAY_AGG(item_id) INTO v_item_ids
        FROM dune.dune_exchange_orders
        WHERE owner_id = v_owner_id AND item_id IS NOT NULL;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id IN (SELECT id FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id);
        DELETE FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id;
        IF v_item_ids IS NOT NULL THEN DELETE FROM dune.items WHERE id = ANY(v_item_ids); END IF;
    END IF;
END $$;` : "";
    const exchangeSql = currentExchangeIdSql();
    return `BEGIN;
CREATE TEMP TABLE market_seed_plan (template_id TEXT NOT NULL, stack_size BIGINT NOT NULL, item_price BIGINT NOT NULL, category_mask INTEGER NOT NULL, category_depth SMALLINT NOT NULL, quality_level BIGINT NOT NULL, seed_kind TEXT NOT NULL, listing_count INTEGER NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_seed_result (status TEXT NOT NULL, exchange_id BIGINT NOT NULL, access_point_id BIGINT NOT NULL, owner_id BIGINT NOT NULL, inventory_id BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO market_seed_plan (template_id, stack_size, item_price, category_mask, category_depth, quality_level, seed_kind, listing_count) VALUES
${valuesSql};
${clearSql}
DO $$
DECLARE
    v_exchange_id BIGINT; v_access_point_id BIGINT; v_inventory_id BIGINT; v_owner_id BIGINT; v_user_id BIGINT; v_partition_id BIGINT; v_next_position BIGINT; v_expiration_time BIGINT; v_balance BIGINT; v_item_id BIGINT; v_order_id BIGINT; rec RECORD; idx INTEGER;
BEGIN
    ${exchangeSql}
    -- Resolve the access point from the accesspoints table first (authoritative:
    -- it is what the game client uses). Fall back to an existing order only if
    -- the table has no row, and never fabricate an id: that violates the FK and
    -- produces listings players cannot see (EDA market bot access-point fix).
    SELECT COALESCE(
        (SELECT id FROM dune.dune_exchange_accesspoints WHERE exchange_id = v_exchange_id ORDER BY id LIMIT 1),
        (SELECT access_point_id FROM dune.dune_exchange_orders WHERE exchange_id = v_exchange_id LIMIT 1)
    ) INTO v_access_point_id;
    IF v_access_point_id IS NULL THEN
        RAISE EXCEPTION 'Exchange % has no access point yet. The game creates one when a player first opens an exchange terminal; seed after that happens.', v_exchange_id;
    END IF;
    SELECT dune.get_exchange_inventory_id(v_exchange_id) INTO v_inventory_id;
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    SELECT dune.dune_exchange_get_user_id(v_owner_id) INTO v_user_id;
    -- Top the bot balance up to 9T only when it dips below the 1T floor,
    -- matching the EDA market bot's balance seeding behavior.
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO dune.dune_exchange_categories_hash (id, hash) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET hash = 0;
    SELECT COALESCE(MAX(position_index), -1) + 1 INTO v_next_position FROM dune.items WHERE inventory_id = v_inventory_id;
    -- Derive listing expiry from the newest non-sentinel order so sentinel
    -- payment entries (999999999) cannot inflate it past the sentinel.
    SELECT LEAST(COALESCE(MAX(expiration_time) + 604800, ${PAYMENT_SENTINEL_EXPIRY}), ${PAYMENT_SENTINEL_EXPIRY}) INTO v_expiration_time
    FROM dune.dune_exchange_orders WHERE expiration_time < ${PAYMENT_SENTINEL_EXPIRY};
    FOR rec IN SELECT * FROM market_seed_plan ORDER BY seed_kind, template_id, quality_level LOOP
        FOR idx IN 1..GREATEST(1, rec.listing_count) LOOP
            INSERT INTO dune.items (inventory_id, stack_size, position_index, template_id, quality_level, stats) VALUES (v_inventory_id, rec.stack_size, v_next_position, rec.template_id, rec.quality_level, '{}') RETURNING id INTO v_item_id;
            v_next_position := v_next_position + 1;
            INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, durability_cur, durability_max, category_mask, category_depth, item_price, quality_level, item_id) VALUES (v_exchange_id, v_access_point_id, v_owner_id, TRUE, v_expiration_time, rec.template_id, 1.0, 1.0, rec.category_mask, rec.category_depth, rec.item_price, rec.quality_level, v_item_id) RETURNING id INTO v_order_id;
            INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (v_order_id, rec.stack_size, rec.item_price);
        END LOOP;
    END LOOP;
    INSERT INTO market_seed_result (status, exchange_id, access_point_id, owner_id, inventory_id) VALUES ('seeded', v_exchange_id, v_access_point_id, v_owner_id, v_inventory_id);
END $$;
SELECT r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id, SUM(listing_count) AS listing_count, SUM(listing_count) FILTER (WHERE seed_kind = 'equippable') AS equippable_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'schematic') AS schematic_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'resource') AS resource_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'ammunition') AS ammunition_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'consumable') AS consumable_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'utility') AS utility_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'cartography') AS cartography_listings, SUM(CASE WHEN seed_kind = 'resource' THEN stack_size * listing_count ELSE 0 END) AS resource_units, ${currentMultiplier()} AS price_multiplier FROM market_seed_plan CROSS JOIN market_seed_result r GROUP BY r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id;
COMMIT;`;
  }

  // Buyback plan: per-template base (grade 0) max unit price scaled by the
  // buyback threshold percent. Grade-adjusted reference prices are computed in
  // SQL from the player order's quality_level using the same grade multipliers
  // the seeder uses, matching EDA's grade-aware buy tick.
  function buybackPlanValuesSql() {
    const rows = baseRowsForCurrentMultiplier();
    const threshold = currentThreshold();
    const maxPrice = new Map();
    for (const row of rows) {
      // Normalize to a grade-0 price: some bundled plan rows carry a non-zero
      // quality_level with an already grade-adjusted price, and the SQL applies
      // the grade multiplier itself. Without this the multiplier stacks twice.
      const grade = clampInteger(row.quality_level, 0, 0, 5);
      const mult = GRADE_MULTIPLIERS[grade] || 1.0;
      const grade0Price = Math.round(Number(row.price) / mult);
      maxPrice.set(row.template_id, Math.max(maxPrice.get(row.template_id) || 0, grade0Price));
    }
    return Array.from(maxPrice.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([templateId, price]) => `(${sqlLiteral(templateId)},${Math.max(1, Math.floor((price * threshold + 99) / 100))})`).join(",\n");
  }

  function buildBuybackSql() {
    const exchangeId = currentExchangeIdValue();
    const threshold = currentThreshold();
    const valuesSql = buybackPlanValuesSql();
    return `BEGIN;
CREATE TEMP TABLE market_buy_plan (template_id TEXT PRIMARY KEY, max_unit_price BIGINT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_result (purchased INTEGER NOT NULL, total_units BIGINT NOT NULL, total_solari BIGINT NOT NULL, threshold_percent INTEGER NOT NULL, max_buys INTEGER NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_diagnostics (player_sell_orders BIGINT NOT NULL, known_player_sell_orders BIGINT NOT NULL, eligible_player_sell_orders BIGINT NOT NULL, above_threshold_sell_orders BIGINT NOT NULL, unknown_template_sell_orders BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO market_buy_plan (template_id, max_unit_price) VALUES
${valuesSql};
DO $$
DECLARE
    v_owner_id BIGINT; v_user_id BIGINT; v_partition_id BIGINT; v_log_order_id BIGINT; v_balance BIGINT; v_purchased INTEGER := 0; v_units BIGINT := 0; v_solari BIGINT := 0; rec RECORD;
BEGIN
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    SELECT dune.dune_exchange_get_user_id(v_owner_id) INTO v_user_id;
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO market_buy_diagnostics SELECT COUNT(*), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL})), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price > FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL})), COUNT(*) FILTER (WHERE p.template_id IS NULL) FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN market_buy_plan p ON p.template_id = o.template_id WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id;
    FOR rec IN SELECT o.id AS order_id, o.exchange_id, o.access_point_id, o.owner_id AS seller_actor_id, o.template_id, o.item_price, o.item_id, COALESCE(i.stack_size, s.initial_stack_size, 1) AS actual_stack, p.max_unit_price FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id JOIN market_buy_plan p ON p.template_id = o.template_id LEFT JOIN dune.items i ON i.id = o.item_id WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL}) ORDER BY o.item_price ASC, o.id ASC LIMIT ${currentMaxBuys()} LOOP
        -- Seller "Take Solari" payment entry. item_price stays the per-unit
        -- price (the game multiplies by stack_size itself) and expiration is
        -- the never-expires sentinel so the game server's expire proc cannot
        -- purge an uncollected payment (EDA "items eaten without payment" fix).
        INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, template_id, expiration_time, durability_cur, durability_max, item_price, category_mask, category_depth, is_npc_order) VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, ${PAYMENT_SENTINEL_EXPIRY}, 1.0, 1.0, rec.item_price, 0, 0, FALSE) RETURNING id INTO v_log_order_id;
        INSERT INTO dune.dune_exchange_fulfilled_orders (order_id, source_order_id, completion_type, stack_size, original_order_id) VALUES (v_log_order_id, NULL, 4, rec.actual_stack, rec.order_id);
        UPDATE dune.dune_exchange_users SET solari_balance = solari_balance - (rec.item_price * rec.actual_stack) WHERE owner_id = v_owner_id;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id = rec.order_id;
        DELETE FROM dune.dune_exchange_orders WHERE id = rec.order_id;
        IF rec.item_id IS NOT NULL THEN DELETE FROM dune.items WHERE id = rec.item_id; END IF;
        v_purchased := v_purchased + 1; v_units := v_units + rec.actual_stack; v_solari := v_solari + (rec.item_price * rec.actual_stack);
    END LOOP;
    INSERT INTO market_buy_result (purchased, total_units, total_solari, threshold_percent, max_buys) VALUES (v_purchased, v_units, v_solari, ${threshold}, ${currentMaxBuys()});
END $$;
SELECT purchased, total_units, total_solari, threshold_percent, max_buys FROM market_buy_result;
SELECT player_sell_orders, known_player_sell_orders, eligible_player_sell_orders, above_threshold_sell_orders, unknown_template_sell_orders FROM market_buy_diagnostics;
COMMIT;`;
  }

  // Read-only eligibility probe used by auto buyback. This runs through
  // database.query (no backup is taken), so idle auto ticks are cheap on
  // self-hosted infrastructure; the write sweep only runs when this finds
  // at least one player listing at or below the threshold.
  function buildBuybackEligibilitySql() {
    const exchangeId = currentExchangeIdValue();
    const valuesSql = buybackPlanValuesSql();
    return `WITH market_buy_plan(template_id, max_unit_price) AS (
    VALUES
${valuesSql}
),
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT COUNT(*)::text AS eligible_orders
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
JOIN market_buy_plan p ON p.template_id = o.template_id
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND o.is_npc_order = FALSE
  AND (b.owner_id IS NULL OR o.owner_id <> b.owner_id)
  AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL});`;
  }

  function buildClearNpcSql() {
    return `BEGIN;
WITH bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
),
target_orders AS MATERIALIZED (
    SELECT o.id, o.item_id
    FROM dune.dune_exchange_orders o
    JOIN bot b ON b.owner_id = o.owner_id
),
deleted_sell_orders AS (
    DELETE FROM dune.dune_exchange_sell_orders s
    USING target_orders t
    WHERE s.order_id = t.id
    RETURNING s.order_id
),
deleted_orders AS (
    DELETE FROM dune.dune_exchange_orders o
    USING target_orders t
    WHERE o.id = t.id
    RETURNING o.id, o.item_id
),
deleted_items AS (
    DELETE FROM dune.items i
    USING deleted_orders d
    WHERE d.item_id IS NOT NULL AND i.id = d.item_id
    RETURNING i.id
)
SELECT
    COALESCE((SELECT owner_id::text FROM bot), 'missing') AS bot_actor_id,
    (SELECT COUNT(*) FROM target_orders)::text AS npc_orders_found,
    (SELECT COUNT(*) FROM deleted_sell_orders)::text AS sell_orders_deleted,
    (SELECT COUNT(*) FROM deleted_orders)::text AS exchange_orders_deleted,
    (SELECT COUNT(*) FROM deleted_items)::text AS backing_items_deleted;
COMMIT;`;
  }

  function buildDropUnsafeSql() {
    const unsafeIds = Array.isArray(payload?.unsafe_template_ids) ? payload.unsafe_template_ids : [];
    if (!unsafeIds.length) return "SELECT 'No unsafe market template ids were bundled in this EDA seed plan.' AS status;";
    const valuesSql = unsafeIds.map((templateId) => `(${sqlLiteral(templateId)})`).join(",\n");
    return `BEGIN;
WITH unsafe_market_templates(template_id) AS (
    VALUES
${valuesSql}
),
target_orders AS MATERIALIZED (
    SELECT o.id, o.item_id, o.template_id
    FROM dune.dune_exchange_orders o
    JOIN unsafe_market_templates u ON u.template_id = o.template_id
    LEFT JOIN dune.actors a ON a.id = o.owner_id
    WHERE o.is_npc_order = TRUE OR a.class = 'Revy'
),
deleted_sell_orders AS (
    DELETE FROM dune.dune_exchange_sell_orders s
    USING target_orders t
    WHERE s.order_id = t.id
    RETURNING s.order_id
),
deleted_orders AS (
    DELETE FROM dune.dune_exchange_orders o
    USING target_orders t
    WHERE o.id = t.id
    RETURNING o.id, o.item_id, o.template_id
),
deleted_items AS (
    DELETE FROM dune.items i
    USING deleted_orders d
    WHERE d.item_id IS NOT NULL AND i.id = d.item_id
    RETURNING i.id
)
SELECT
    (SELECT COUNT(*) FROM unsafe_market_templates)::text AS unsafe_template_count,
    (SELECT COUNT(*) FROM target_orders)::text AS npc_orders_found,
    (SELECT COUNT(*) FROM deleted_sell_orders)::text AS sell_orders_deleted,
    (SELECT COUNT(*) FROM deleted_orders)::text AS exchange_orders_deleted,
    (SELECT COUNT(*) FROM deleted_items)::text AS backing_items_deleted;
COMMIT;`;
  }

  async function executeWrite(label, sql, options = {}) {
    if (writeInProgress) {
      statusEl.className = "status error";
      statusEl.textContent = "Another write is already in progress.";
      return false;
    }
    const confirmPrompt = options.confirmPrompt !== false;
    if (!exchangesLoaded && ["Seed NPC sell market"].includes(label)) {
      statusEl.className = "status error";
      statusEl.textContent = "Exchange list is not loaded yet. Refresh exchanges before seeding.";
      return false;
    }
    if (confirmPrompt && !confirm(`${label}? RedBlink will create a database backup before this write. This may take some time.`)) return false;
    statusEl.className = "status";
    statusEl.textContent = `${label} starting. RedBlink is creating a backup before the database write...`;
    resultEl.textContent = "Running...";
    writeInProgress = true;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    try {
      const result = await requestBridge("database.execute", { query: sql });
      statusEl.className = "status ok";
      statusEl.textContent = `${label} complete.`;
      resultEl.textContent = JSON.stringify(result, null, 2);
      try { rememberExchangeId(exchangeIdEl.value); } catch { /* nothing selected */ }
      if (label === "Seed NPC sell market" || label === "Clear EDA NPC listings" || label === "Drop unsafe NPC listings") {
        await loadExchanges();
      }
      return true;
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
      resultEl.textContent = error.stack || error.message || String(error);
      return false;
    } finally {
      writeInProgress = false;
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    }
  }

  function runWrite(label, sqlBuilder, options = {}) {
    try {
      return executeWrite(label, sqlBuilder(), options);
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
      resultEl.textContent = error.stack || error.message || String(error);
      return Promise.resolve(false);
    }
  }

  function setAutoStatus(message, className = "status") {
    autoStatusEl.className = className;
    autoStatusEl.textContent = message;
  }

  function describeNextRun() {
    if (!nextAutoRunAt) return "";
    const remainingMs = Math.max(0, nextAutoRunAt - Date.now());
    const minutes = Math.round(remainingMs / 60000);
    return minutes <= 0 ? "next run imminent" : `next run in ~${minutes} min`;
  }

  async function runAutoBuyback() {
    autoRunning = true;
    nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
    try {
      const checkResult = await requestBridge("database.query", { query: buildBuybackEligibilitySql() });
      const eligible = Number(checkResult?.rows?.[0]?.eligible_orders || 0);
      if (!Number.isFinite(eligible) || eligible <= 0) {
        setAutoStatus(`Auto buyback: nothing eligible at ${currentThreshold()}% threshold; skipped the write (and its backup). ${describeNextRun()}.`);
        return;
      }
      setAutoStatus(`Auto buyback: ${eligible.toLocaleString()} eligible player listings found; running sweep...`);
      const ok = await runWrite("Auto buyback sweep", buildBuybackSql, { confirmPrompt: false });
      if (ok) {
        setAutoStatus(`Auto buyback: sweep finished at ${new Date().toLocaleTimeString()}. ${describeNextRun()}.`, "status ok");
      } else {
        setAutoStatus(`Auto buyback: sweep failed; check the status above. ${describeNextRun()}.`, "status error");
      }
    } catch (error) {
      setAutoStatus(`Auto buyback failed: ${error.message || String(error)}. ${describeNextRun()}.`, "status error");
    } finally {
      // Re-arm from completion time, not sweep start, so a write that outlasts
      // the interval cannot trigger back-to-back runs.
      nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
      autoRunning = false;
    }
  }

  function autoBuybackTick() {
    if (!autoBuybackEl.checked) return;
    if (!payload || autoRunning || writeInProgress) return;
    if (!exchangesLoaded || !String(exchangeIdEl.value || "").trim()) {
      setAutoStatus("Auto buyback is waiting for an exchange to be selected.");
      return;
    }
    if (Date.now() < nextAutoRunAt) return;
    void runAutoBuyback();
  }

  function onAutoBuybackToggle() {
    if (autoBuybackEl.checked) {
      // First run happens one full interval after enabling, so turning the
      // feature on never fires an immediate surprise write.
      nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
      setAutoStatus(`Auto buyback armed: every ${currentAutoIntervalMinutes()} min while this page stays open. Each run checks eligibility with a read-only query first and only writes (with backup) when there is something to buy. ${describeNextRun()}.`);
    } else {
      nextAutoRunAt = 0;
      setAutoStatus("Auto buyback is off.");
    }
  }

  async function loadSeedPlan() {
    statusEl.className = "status";
    statusEl.textContent = "Loading bundled Easy Dune Admin market seed plan...";
    try {
      const response = await fetch("market-seed-plan.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Seed plan returned HTTP ${response.status}.`);
      payload = await response.json();
      if (!localStorage.getItem(settingsStorageKey)) {
        multiplierEl.value = String(payload.price_multiplier || 5);
      }
      refreshPreview();
      await loadExchanges();
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
    }
  }

  restoreSettings();
  onAutoBuybackToggle();

  filterEl.addEventListener("input", renderRows);
  kindFilterEl.addEventListener("change", renderRows);
  for (const el of [multiplierEl, schematicGradesEl, schematicPerGradeEl, materialListingsEl]) {
    el.addEventListener("change", () => { persistSettings(); refreshPreview(); });
  }
  for (const el of [thresholdEl, maxBuysEl, clearExistingEl]) {
    el.addEventListener("change", persistSettings);
  }
  autoBuybackEl.addEventListener("change", () => { persistSettings(); onAutoBuybackToggle(); });
  autoBuybackIntervalEl.addEventListener("change", () => { persistSettings(); if (autoBuybackEl.checked) onAutoBuybackToggle(); });
  document.getElementById("refreshPreview").addEventListener("click", refreshPreview);
  document.getElementById("refreshExchanges").addEventListener("click", () => void loadExchanges());
  document.getElementById("addExchange").addEventListener("click", addManualExchange);
  document.getElementById("seedMarket").addEventListener("click", () => void runWrite("Seed NPC sell market", buildSeedSql));
  document.getElementById("buySweep").addEventListener("click", () => void runWrite("Run buyback sweep", buildBuybackSql));
  document.getElementById("clearNpc").addEventListener("click", () => void runWrite("Clear EDA NPC listings", buildClearNpcSql));
  document.getElementById("dropUnsafe").addEventListener("click", () => void runWrite("Drop unsafe NPC listings", buildDropUnsafeSql));
  window.setInterval(autoBuybackTick, 15000);
  loadSeedPlan();
})();
