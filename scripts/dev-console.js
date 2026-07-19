#!/usr/bin/env node
"use strict";

// Local stand-in for RedBlink Dune Docker Console: serves the addon in an
// iframe and implements the dune-addon-request/response postMessage bridge,
// forwarding database.query / database.execute to a real PostgreSQL database
// via psql. For manual testing only; never ship this with the addon package.
//
// Usage:
//   node scripts/dev-console.js [--db <database>] [--port <port>]
//
// The database must already contain the dune schema (for a throwaway one,
// load tests/fixtures/dune-schema.sql first).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const DB_NAME = argValue("--db", "eda_bot_dev");
const PORT = Number(argValue("--port", "8787"));

const webDir = path.join(__dirname, "..", "web");

function runPsql(extraArgs, input) {
  const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB_NAME, ...extraArgs], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "psql failed").trim());
  }
  return result.stdout;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      values.push(value);
      value = "";
    } else {
      value += ch;
    }
  }
  values.push(value);
  return values;
}

// psql --csv emits t/f for booleans; the console bridge returns real JSON
// booleans, so mirror that for the fields the addon reads as booleans.
function normalizeValue(column, value) {
  if (column === "is_global") return value === "t";
  return value;
}

function queryObjects(sql) {
  const out = runPsql(["--csv", "-c", sql]);
  const lines = out.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((column, index) => [column, normalizeValue(column, values[index])]));
  });
}

const parentPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dev Console Harness - EDA Exchange Bot</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #14161c; color: #e8e8e8; }
    header { padding: 8px 16px; background: #1f2430; font-size: 14px; }
    iframe { display: block; width: 100%; height: calc(100vh - 37px); border: 0; background: #fff; }
  </style>
</head>
<body>
  <header>RedBlink dev console harness (database: ${DB_NAME}) - bridge requests are forwarded to PostgreSQL via psql</header>
  <iframe id="addon" src="/web/index.html"></iframe>
  <script>
    const iframe = document.getElementById("addon");
    window.addEventListener("message", async (event) => {
      const message = event.data || {};
      if (message.type !== "dune-addon-request") return;
      const reply = { type: "dune-addon-response", addonId: message.addonId, requestId: message.requestId };
      try {
        const endpoint = message.action === "database.query" ? "/api/query"
          : message.action === "database.execute" ? "/api/execute"
          : null;
        if (!endpoint) throw new Error("Unsupported bridge action: " + message.action);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload || {})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bridge call failed.");
        reply.ok = true;
        reply.result = result;
      } catch (error) {
        reply.ok = false;
        reply.error = String(error.message || error);
      }
      iframe.contentWindow.postMessage(reply, window.location.origin);
    });
  </script>
</body>
</html>`;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(parentPage);
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/query" || url.pathname === "/api/execute")) {
      const payload = JSON.parse((await readBody(request)) || "{}");
      const sql = String(payload.query || "");
      let result;
      if (url.pathname === "/api/query") {
        result = { rows: queryObjects(sql) };
      } else {
        runPsql(["-f", "-"], sql);
        result = { rows: [], status: "executed" };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/web/")) {
      const relative = url.pathname.slice("/web/".length);
      const filePath = path.join(webDir, relative);
      if (!filePath.startsWith(webDir + path.sep) || !fs.existsSync(filePath)) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(fs.readFileSync(filePath));
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error.message || error) }));
  }
});

server.listen(PORT, () => {
  console.log(`Dev console harness: http://localhost:${PORT}/ (database: ${DB_NAME})`);
});
