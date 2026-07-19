"use strict";

// Minimal PostgreSQL driver built on the psql CLI, so the tests exercise the
// addon's generated SQL against a real server without extra npm dependencies.
// Connection settings come from the standard PG* environment variables.

const { spawnSync, execFileSync } = require("child_process");

function psqlAvailable() {
  const result = spawnSync("psql", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function adminDb() {
  return process.env.PGDATABASE || process.env.USER || "postgres";
}

function runPsql(args, input) {
  const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function createTestDb(name) {
  spawnSync("psql", ["-X", "-d", adminDb(), "-c", `DROP DATABASE IF EXISTS ${name}`], { encoding: "utf8" });
  runPsql(["-d", adminDb(), "-c", `CREATE DATABASE ${name}`]);
}

function dropTestDb(name) {
  spawnSync("psql", ["-X", "-d", adminDb(), "-c", `DROP DATABASE IF EXISTS ${name}`], { encoding: "utf8" });
}

// Execute a SQL script (multiple statements, DO blocks, BEGIN/COMMIT) exactly
// as the RedBlink bridge would hand it to the database.
function execSql(dbName, sql) {
  return runPsql(["-d", dbName, "-f", "-"], sql);
}

// Run a single query and return rows as arrays of text column values.
function queryRows(dbName, sql) {
  const out = runPsql(["-d", dbName, "-At", "-F", "\u0001", "-c", sql]);
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\u0001"));
}

// Run a single query and return rows as objects keyed by column name, the
// same shape the RedBlink bridge returns for database.query.
function queryObjects(dbName, sql) {
  const out = runPsql(["-d", dbName, "--csv", "-c", sql]);
  const lines = out.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const parseCsvLine = (line) => {
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
  };
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((column, index) => [column, values[index]]));
  });
}

function queryOne(dbName, sql) {
  const rows = queryRows(dbName, sql);
  if (rows.length !== 1 || rows[0].length !== 1) {
    throw new Error(`Expected a single value from: ${sql}\nGot: ${JSON.stringify(rows)}`);
  }
  return rows[0][0];
}

function loadFixture(dbName, fixturePath) {
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", fixturePath], { encoding: "utf8" });
}

module.exports = { psqlAvailable, createTestDb, dropTestDb, execSql, queryRows, queryObjects, queryOne, loadFixture };
