#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";

const TYPE_PATTERNS = [
  ["boolean", /^boolean\b/i],
  ["integer", /^(?:smallint|integer|bigint)\b/i],
  ["number", /^(?:numeric|decimal|real|double precision)\b/i],
  ["text", /^(?:character varying|varchar|character|char|text)\b/i],
  ["json", /^jsonb?\b/i],
  ["uuid", /^uuid\b/i],
  ["date", /^(?:timestamp\s+(?:without|with)\s+time\s+zone|time\s+(?:without|with)\s+time\s+zone|date)\b/i],
  ["blob", /^bytea\b/i]
];

const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CHECK_SQL = {
  billing_adjustments_calculation_check: '"calculation" IN (\'percent\', \'fixed\')',
  billing_adjustments_kind_check: '"kind" IN (\'discount\', \'charge\')',
  billing_adjustments_value_check: '"value" >= 0',
  business_licenses_valid_term: '(("license_type" = \'Trial\' AND "duration_months" = 1) OR ("license_type" = \'Sales\' AND "duration_months" IN (3, 6, 12)))',
  business_sequence_counters_next_number_check: '"next_number" > 0',
  expenses_amount_check: '"amount" >= 0',
  invoice_number_counters_next_number_check: '"next_number" > 0',
  qr_guest_otp_challenges_attempts_check: '"attempts" >= 0 AND "attempts" <= 5',
  qr_guest_otp_challenges_menu_token_hash_check: 'length("menu_token_hash") = 64 AND "menu_token_hash" NOT GLOB \'*[^0-9a-f]*\'',
  qr_guest_otp_challenges_phone_check: 'length("phone") = 10 AND "phone" NOT GLOB \'*[^0-9]*\'',
  qr_guest_sessions_menu_token_hash_check: 'length("menu_token_hash") = 64 AND "menu_token_hash" NOT GLOB \'*[^0-9a-f]*\'',
  qr_guest_sessions_phone_check: 'length("phone") = 10 AND "phone" NOT GLOB \'*[^0-9]*\'',
  qr_guest_sessions_session_token_hash_check: 'length("session_token_hash") = 64 AND "session_token_hash" NOT GLOB \'*[^0-9a-f]*\'',
  qr_service_requests_request_type_check: '"request_type" IN (\'clean_table\', \'call_waiter\')'
};

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (["--input", "--schema-output", "--data-output", "--manifest-output"].includes(args[i])) {
      options[args[i].slice(2)] = args[++i];
    } else {
      throw new Error("Usage: node scripts/pgdump-public-to-d1.js --input <backup.sql> --schema-output <schema.sql> --data-output <snapshot.sql> --manifest-output <manifest.json>");
    }
  }
  for (const key of ["input", "schema-output", "data-output", "manifest-output"]) {
    if (!options[key]) throw new Error("Missing required option --" + key + ".");
  }
  return options;
}

function sqliteType(pgType) {
  const type = pgType.trim();
  for (const [kind, pattern] of TYPE_PATTERNS) {
    if (pattern.test(type)) {
      if (kind === "boolean" || kind === "integer") return { kind, sql: "INTEGER" };
      if (kind === "number") return { kind, sql: "NUMERIC" };
      if (kind === "blob") return { kind, sql: "BLOB" };
      return { kind, sql: "TEXT" };
    }
  }
  throw new Error("Unsupported PostgreSQL public column type: " + type);
}

function parseColumnType(rest) {
  const candidates = [
    /^character varying(?:\s*\([^)]*\))?/i,
    /^varchar(?:\s*\([^)]*\))?/i,
    /^character(?:\s*\([^)]*\))?/i,
    /^char(?:\s*\([^)]*\))?/i,
    /^timestamp\s+(?:without|with)\s+time\s+zone/i,
    /^time\s+(?:without|with)\s+time\s+zone/i,
    /^double precision/i,
    /^numeric(?:\s*\([^)]*\))?/i,
    /^decimal(?:\s*\([^)]*\))?/i,
    /^smallint/i,
    /^integer/i,
    /^bigint/i,
    /^boolean/i,
    /^jsonb?/i,
    /^text\b/i,
    /^uuid/i,
    /^date/i,
    /^bytea/i,
    /^real/i
  ];
  for (const pattern of candidates) {
    const match = rest.match(pattern);
    if (match) return match[0];
  }
  throw new Error("Could not identify a PostgreSQL column type from: " + rest.slice(0, 80));
}

function quoteIdentifier(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

function sqlText(value) {
  if (value.includes(String.fromCharCode(0))) {
    throw new Error("SQLite text values cannot contain a NUL character.");
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

function safeDefault(rest) {
  const match = rest.match(/\bDEFAULT\s+([\s\S]+)$/i);
  if (!match) return null;
  let raw = match[1].trim().replace(/,\s*$/, "");
  raw = raw.replace(/\s+NOT NULL\b[\s\S]*$/i, "").trim();
  while (raw.length > 1 && raw.startsWith("(") && raw.endsWith(")")) {
    raw = raw.slice(1, -1).trim();
  }

  if (/^(?:CURRENT_TIMESTAMP|CURRENT_DATE)$/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^(?:true|false)$/i.test(raw)) return raw.toLowerCase() === "true" ? "1" : "0";
  if (/^NULL$/i.test(raw)) return "NULL";

  const numeric = raw.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*::[\s\S]+)?$/);
  if (numeric) return numeric[1];

  const text = raw.match(/^'((?:[^']|'')*)'(?:\s*::[\s\S]+)?$/);
  if (text) return "'" + text[1] + "'";
  return null;
}

function parsePublicTables(source) {
  const tables = new Map();
  const createTable = /^CREATE TABLE public\.([A-Za-z0-9_]+)\s+\(\r?\n([\s\S]*?)^\);/gm;
  let match;

  while ((match = createTable.exec(source))) {
    const name = match[1];
    const columns = [];
    const inlineChecks = [];
    for (const rawLine of match[2].split(/\r?\n/)) {
      const line = rawLine.trim().replace(/,\s*$/, "");
      if (!line) continue;
      const check = line.match(/^CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK\s*\(([\s\S]*)\)$/i);
      if (check) {
        if (!CHECK_SQL[check[1]]) throw new Error("No SQLite translation defined for CHECK constraint " + check[1] + ".");
        inlineChecks.push({ name: check[1], sql: CHECK_SQL[check[1]] });
        continue;
      }
      if (/^CONSTRAINT\b/i.test(line)) continue;
      const col = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/);
      if (!col) continue;
      const pgType = parseColumnType(col[2]);
      const mapped = sqliteType(pgType);
      columns.push({
        name: col[1],
        pgType,
        kind: mapped.kind,
        sqlType: mapped.sql,
        notNull: /\bNOT NULL\b/i.test(col[2]),
        defaultSql: safeDefault(col[2])
      });
    }
    if (!columns.length) throw new Error("No columns parsed for public." + name + ".");
    tables.set(name, { name, columns, primaryKey: [], foreignKeys: [], uniqueConstraints: [], checkConstraints: inlineChecks });
  }
  if (tables.size !== 46) {
    throw new Error("Expected 46 public application tables in the backup, found " + tables.size + ".");
  }

  const constraint = /^ALTER TABLE ONLY public\.([A-Za-z0-9_]+)\s+ADD CONSTRAINT\s+([A-Za-z0-9_]+)\s+([\s\S]*?);/gm;
  while ((match = constraint.exec(source))) {
    const table = tables.get(match[1]);
    if (!table) continue;
    const definition = match[3].trim();
    const primary = definition.match(/^PRIMARY KEY\s*\(([^)]+)\)/i);
    if (primary) {
      table.primaryKey = primary[1].split(",").map(value => value.trim().replace(/"/g, ""));
      continue;
    }
    const unique = definition.match(/^UNIQUE\s*\(([^)]+)\)/i);
    if (unique) {
      table.uniqueConstraints.push({
        name: match[2],
        columns: unique[1].split(",").map(value => value.trim().replace(/"/g, ""))
      });
      continue;
    }
    const check = definition.match(/^CHECK\s*\(([\s\S]*)\)$/i);
    if (check) {
      if (!CHECK_SQL[match[2]]) throw new Error("No SQLite translation defined for CHECK constraint " + match[2] + ".");
      table.checkConstraints.push({ name: match[2], sql: CHECK_SQL[match[2]] });
      continue;
    }
    const foreign = definition.match(/^FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+public\.([A-Za-z0-9_]+)\s*\(([^)]+)\)([\s\S]*)$/i);
    if (foreign) {
      const parent = tables.get(foreign[2]);
      if (!parent) throw new Error("Foreign key references unknown public table " + foreign[2] + ".");
      const actions = foreign[4].match(/\bON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)\b/gi) || [];
      table.foreignKeys.push({
        columns: foreign[1].split(",").map(value => value.trim().replace(/"/g, "")),
        parentTable: foreign[2],
        parentColumns: foreign[3].split(",").map(value => value.trim().replace(/"/g, "")),
        actions: [...new Set(actions.map(value => value.toUpperCase()))]
      });
    }
  }

  for (const table of tables.values()) {
    if (!table.primaryKey.length) throw new Error("No primary key found for public." + table.name + ".");
    for (const key of table.primaryKey) {
      if (!table.columns.some(column => column.name === key)) {
        throw new Error("Unknown primary key column " + key + " on public." + table.name + ".");
      }
    }
  }
  return tables;
}

function topologicalTableOrder(tables) {
  const remaining = new Set(tables.keys());
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(name => {
      const table = tables.get(name);
      return table.foreignKeys.every(fk => {
        // businesses.profile_id and access_profiles.business_id form a real schema cycle.
        // Business rows are imported with profile_id NULL, then linked after profiles exist.
        if (name === "businesses" && fk.parentTable === "access_profiles" && fk.columns.includes("profile_id")) return true;
        return !remaining.has(fk.parentTable);
      });
    }).sort();
    if (!ready.length) {
      throw new Error("Foreign key dependency cycle remains among: " + [...remaining].join(", "));
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

function parseIndexes(source, tables) {
  const indexes = [];
  const statements = source.match(/^CREATE (?:UNIQUE )?INDEX[\s\S]*?;/gm) || [];
  for (const statement of statements) {
    if (!/\bON\s+public\./i.test(statement)) continue;
    const prefix = statement.match(/^CREATE (UNIQUE )?INDEX\s+([A-Za-z0-9_]+)\s+ON\s+public\.([A-Za-z0-9_]+)\s+USING\s+([A-Za-z0-9_]+)\s*\(/i);
    if (!prefix) throw new Error("Unsupported public index syntax: " + statement.slice(0, 140));
    if (prefix[4].toLowerCase() !== "btree") {
      throw new Error("Unsupported public index method " + prefix[4] + " for " + prefix[2] + ".");
    }
    const table = tables.get(prefix[3]);
    if (!table) throw new Error("Index references unknown public table " + prefix[3] + ".");

    const open = statement.indexOf("(", prefix[0].length - 1);
    let depth = 0;
    let quote = false;
    let close = -1;
    for (let i = open; i < statement.length; i += 1) {
      const char = statement[i];
      if (char === "'" && statement[i + 1] === "'" && quote) { i += 1; continue; }
      if (char === "'") { quote = !quote; continue; }
      if (quote) continue;
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) throw new Error("Could not parse index expressions for " + prefix[2] + ".");

    let columns = statement.slice(open + 1, close).trim();
    let tail = statement.slice(close + 1).trim().replace(/;$/, "").trim();
    let where = "";
    if (tail) {
      const whereMatch = tail.match(/^WHERE\s+([\s\S]+)$/i);
      if (!whereMatch) throw new Error("Unsupported index suffix for " + prefix[2] + ".");
      where = whereMatch[1].trim();
    }

    columns = columns.replace(/::(?:character varying|character|timestamp without time zone|timestamp with time zone|time without time zone|double precision|[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)/gi, "");
    where = where.replace(/::(?:character varying|character|timestamp without time zone|timestamp with time zone|time without time zone|double precision|[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)/gi, "");

    if (/ARRAY\s*\[/i.test(where) && /<>?\s+ALL/i.test(where)) {
      where = "public_session_key IS NOT NULL AND status NOT IN ('Completed', 'Cancelled')";
    }
    where = where.replace(/\b=\s*true\b/gi, "= 1").replace(/\b=\s*false\b/gi, "= 0");
    columns = columns.replace(/\s+/g, " ").trim();
    where = where.replace(/\s+/g, " ").trim();

    if (columns.includes("::") || where.includes("::") || /\bARRAY\b|\bANY\b|\bALL\b/i.test(where)) {
      throw new Error("PostgreSQL-only syntax remains in index " + prefix[2] + ".");
    }

    const unique = Boolean(prefix[1]);
    const isPrimaryKeyIndex = unique && !where &&
      table.primaryKey.join(",").toLowerCase() === columns.split(",").map(value => value.trim().replace(/[()"]/g, "").toLowerCase()).join(",");
    if (isPrimaryKeyIndex) continue;

    indexes.push(
      "CREATE " + (unique ? "UNIQUE " : "") + "INDEX IF NOT EXISTS " +
      quoteIdentifier(prefix[2]) + " ON " + quoteIdentifier(prefix[3]) +
      " (" + columns + ")" + (where ? " WHERE " + where : "") + ";"
    );
  }
  return indexes;
}

function renderSchema(tables, indexes, includeSupplementalConstraints = true) {
  const order = topologicalTableOrder(tables);
  const out = [
    "-- Full public-app schema translated from the PostgreSQL backup to SQLite/D1.",
    "-- PostgreSQL RLS policies and server functions/non-check triggers are not executable in D1;",
    "-- tenant authorization must be enforced by the Worker/API. CHECK rules are in 0002.",
    ""
  ];

  for (const name of order) {
    const table = tables.get(name);
    const singleIntegerKey = table.primaryKey.length === 1 &&
      table.columns.find(column => column.name === table.primaryKey[0])?.sqlType === "INTEGER";
    const definitions = table.columns.map(column => {
      let definition = quoteIdentifier(column.name) + " " + column.sqlType;
      if (singleIntegerKey && column.name === table.primaryKey[0]) {
        definition += " PRIMARY KEY";
      } else if (column.notNull) {
        definition += " NOT NULL";
      }
      if (column.defaultSql !== null && !(singleIntegerKey && column.name === table.primaryKey[0])) {
        definition += " DEFAULT " + column.defaultSql;
      }
      return definition;
    });

    if (!singleIntegerKey) {
      definitions.push("PRIMARY KEY (" + table.primaryKey.map(quoteIdentifier).join(", ") + ")");
    }
    for (const fk of table.foreignKeys) {
      let definition = "FOREIGN KEY (" + fk.columns.map(quoteIdentifier).join(", ") + ") " +
        "REFERENCES " + quoteIdentifier(fk.parentTable) + " (" + fk.parentColumns.map(quoteIdentifier).join(", ") + ")";
      for (const action of fk.actions) definition += " " + action;
      definitions.push(definition);
    }
    out.push("CREATE TABLE IF NOT EXISTS " + quoteIdentifier(name) + " (");
    out.push("  " + definitions.join(",\n  "));
    out.push(");", "");
  }

  out.push("-- Private import helper for values that exceed D1's SQL statement limit.");
  out.push('CREATE TABLE IF NOT EXISTS "_migration_import_chunks" (');
  out.push('  "owner_table" TEXT NOT NULL, "owner_key" TEXT NOT NULL,');
  out.push('  "column_name" TEXT NOT NULL, "chunk_index" INTEGER NOT NULL, "chunk_value" TEXT NOT NULL,');
  out.push('  PRIMARY KEY ("owner_table", "owner_key", "column_name", "chunk_index")');
  out.push(");", "");
  out.push("-- PostgreSQL indexes translated to SQLite/D1.", ...indexes, "");
  if (!includeSupplementalConstraints) return out.join("\n");
  out.push("-- PostgreSQL unique constraints translated to SQLite unique indexes.");
  for (const table of tables.values()) {
    for (const unique of table.uniqueConstraints) {
      out.push("CREATE UNIQUE INDEX IF NOT EXISTS " + quoteIdentifier(unique.name) +
        " ON " + quoteIdentifier(table.name) + " (" + unique.columns.map(quoteIdentifier).join(", ") + ");");
    }
  }
  out.push("", "-- SQLite triggers preserve PostgreSQL CHECK rules on INSERT and UPDATE.");
  for (const table of tables.values()) {
    for (const check of table.checkConstraints) {
      for (const operation of ["INSERT", "UPDATE"]) {
        const trigger = "d1_check_" + check.name + "_" + operation.toLowerCase();
        const triggerCondition = check.sql.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, 'NEW."$1"');
        out.push("CREATE TRIGGER IF NOT EXISTS " + quoteIdentifier(trigger) + " BEFORE " + operation +
          " ON " + quoteIdentifier(table.name) + " WHEN NOT (" + triggerCondition + ") BEGIN SELECT RAISE(ABORT, " +
          sqlText("constraint failed: " + check.name) + "); END;");
      }
    }
  }
  out.push("");
  return out.join("\n");
}

function renderSupplementalConstraints(tables) {
  const out = [
    "-- Supplemental constraints translated from the PostgreSQL backup.",
    "-- Apply after 0001_public_schema.sql and before importing snapshot data.",
    ""
  ];
  for (const table of tables.values()) {
    for (const unique of table.uniqueConstraints) {
      out.push("CREATE UNIQUE INDEX IF NOT EXISTS " + quoteIdentifier(unique.name) +
        " ON " + quoteIdentifier(table.name) + " (" + unique.columns.map(quoteIdentifier).join(", ") + ");");
    }
  }
  for (const table of tables.values()) {
    for (const check of table.checkConstraints) {
      for (const operation of ["INSERT", "UPDATE"]) {
        const trigger = "d1_check_" + check.name + "_" + operation.toLowerCase();
        const triggerCondition = check.sql.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, 'NEW."$1"');
        out.push("CREATE TRIGGER IF NOT EXISTS " + quoteIdentifier(trigger) + " BEFORE " + operation +
          " ON " + quoteIdentifier(table.name) + " WHEN NOT (" + triggerCondition + ") BEGIN SELECT RAISE(ABORT, " +
          sqlText("constraint failed: " + check.name) + "); END;");
      }
    }
  }
  return out.join("\n") + "\n";
}

function unescapeCopyField(raw) {
  if (raw === "\\N") return null;
  let result = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== "\\") {
      result += char;
      continue;
    }
    i += 1;
    if (i >= raw.length) { result += "\\"; break; }
    const escaped = raw[i];
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
    if (Object.hasOwn(simple, escaped)) {
      result += simple[escaped];
    } else if (escaped === "x") {
      const match = raw.slice(i + 1, i + 3).match(/^[0-9a-fA-F]{1,2}/);
      if (match) {
        result += String.fromCharCode(parseInt(match[0], 16));
        i += match[0].length;
      } else result += "x";
    } else if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(raw[i + 1] || "")) digits += raw[++i];
      result += String.fromCharCode(parseInt(digits, 8));
    } else {
      result += escaped;
    }
  }
  return result;
}

function sqlValue(value, kind, table, column) {
  if (value === null) return "NULL";
  if (kind === "boolean") {
    if (["t", "true", "1"].includes(value.toLowerCase())) return "1";
    if (["f", "false", "0"].includes(value.toLowerCase())) return "0";
    throw new Error("Invalid boolean in public." + table + "." + column + ".");
  }
  if (kind === "integer") {
    if (!INTEGER.test(value)) throw new Error("Invalid integer in public." + table + "." + column + ".");
    return value;
  }
  if (kind === "number") {
    if (!NUMBER.test(value)) throw new Error("Invalid number in public." + table + "." + column + ".");
    return value;
  }
  if (kind === "blob") {
    const bytes = value.match(/^\\\\x([0-9a-fA-F]*)$/);
    if (!bytes || bytes[1].length % 2) throw new Error("Unsupported bytea value in public." + table + "." + column + ".");
    return "X'" + bytes[1] + "'";
  }
  return sqlText(value);
}

function splitUtf8(value, maxBytes) {
  const chunks = [];
  let chunk = "";
  let size = 0;
  for (const char of value) {
    const charSize = Buffer.byteLength(char, "utf8");
    if (size + charSize > maxBytes && chunk) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += char;
    size += charSize;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function exportCopyData(source, tables, tableOrder) {
  const rowsByTable = new Map([...tables.keys()].map(name => [name, []]));
  const countsByBusiness = {};
  const seen = new Set();
  const lines = source.split(/\r?\n/);
  const copyHeader = /^COPY public\.([A-Za-z0-9_]+) \((.*?)\) FROM stdin;$/;

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(copyHeader);
    if (!header) continue;
    const name = header[1];
    const table = tables.get(name);
    if (!table) throw new Error("COPY data references unknown public table " + name + ".");
    seen.add(name);
    const columns = header[2].split(",").map(value => value.trim());
    if (columns.length !== table.columns.length ||
        table.columns.some(column => !columns.includes(column.name))) {
      throw new Error("COPY columns do not match the DDL for public." + name + ".");
    }

    const businessIndex = columns.indexOf("business_id");
    i += 1;
    while (i < lines.length && lines[i] !== "\\.") {
      if (lines[i] === "") { i += 1; continue; }
      const rawValues = lines[i].split("\t");
      if (rawValues.length !== columns.length) {
        throw new Error("Unexpected COPY field count for public." + name + " near source line " + (i + 1) + ".");
      }
      const values = rawValues.map(unescapeCopyField);
      if (businessIndex >= 0 && values[businessIndex] !== null) {
        const id = values[businessIndex];
        countsByBusiness[id] = (countsByBusiness[id] || 0) + 1;
      }
      rowsByTable.get(name).push({ columns, values });
      i += 1;
    }
    if (i >= lines.length) throw new Error("Missing COPY terminator for public." + name + ".");
  }

  if (seen.size !== tables.size) {
    const missing = [...tables.keys()].filter(name => !seen.has(name));
    throw new Error("Missing COPY sections for public tables: " + missing.join(", "));
  }

  const statements = [
    "-- Full public-table snapshot generated from the PostgreSQL COPY data.",
    "-- Import only into the separate cafe-pos-full-dev D1 staging database.",
    "-- Integers/decimals/booleans are converted to SQLite-compatible values.",
    "-- Large text/JSON values are split into bounded inserts, then restored exactly.",
    ""
  ];
  const updateBusinessProfiles = [];
  const restoreLargeValues = [];
  const maxInlineStatementBytes = 80000;
  const chunkBytes = 40000;

  for (const name of tableOrder) {
    const table = tables.get(name);
    for (const row of rowsByTable.get(name)) {
      const values = row.values.slice();
      if (name === "businesses") {
        const profileIndex = row.columns.indexOf("profile_id");
        const idIndex = row.columns.indexOf("id");
        if (profileIndex >= 0 && values[profileIndex] !== null) {
          updateBusinessProfiles.push(
            "UPDATE \"businesses\" SET \"profile_id\" = " +
            sqlValue(values[profileIndex], "integer", name, "profile_id") +
            " WHERE \"id\" = " + sqlValue(values[idIndex], "integer", name, "id") + ";"
          );
          values[profileIndex] = null;
        }
      }

      const ownerKey = JSON.stringify(table.primaryKey.map(key => {
        const index = row.columns.indexOf(key);
        return values[index];
      }));
      const valuesSql = values.map((value, index) => {
        const columnName = row.columns[index];
        const column = table.columns.find(item => item.name === columnName);
        if (value !== null && (column.kind === "text" || column.kind === "json") &&
            Buffer.byteLength(value, "utf8") > chunkBytes) {
          const chunks = splitUtf8(value, chunkBytes);
          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            statements.push(
              'INSERT OR REPLACE INTO "_migration_import_chunks" ' +
              '("owner_table", "owner_key", "column_name", "chunk_index", "chunk_value") VALUES (' +
              [sqlText(name), sqlText(ownerKey), sqlText(columnName), String(chunkIndex), sqlText(chunks[chunkIndex])].join(", ") + ");"
            );
          }
          const keyPredicate = table.primaryKey.map(key => {
            const keyIndex = row.columns.indexOf(key);
            const keyColumn = table.columns.find(item => item.name === key);
            return quoteIdentifier(key) + " = " + sqlValue(values[keyIndex], keyColumn.kind, name, key);
          }).join(" AND ");
          restoreLargeValues.push(
            "UPDATE " + quoteIdentifier(name) + " SET " + quoteIdentifier(columnName) +
            ' = (SELECT group_concat("chunk_value", \'\') FROM (' +
            'SELECT "chunk_value" FROM "_migration_import_chunks" WHERE "owner_table" = ' + sqlText(name) +
            ' AND "owner_key" = ' + sqlText(ownerKey) + ' AND "column_name" = ' + sqlText(columnName) +
            ' ORDER BY "chunk_index")) WHERE ' + keyPredicate + ";"
          );
          return column.kind === "json" ? "'{}'" : "''";
        }
        return sqlValue(value, column.kind, name, columnName);
      });
      const insert = "INSERT OR REPLACE INTO " + quoteIdentifier(name) + " (" +
        row.columns.map(quoteIdentifier).join(", ") + ") VALUES (" + valuesSql.join(", ") + ");";
      if (Buffer.byteLength(insert, "utf8") > maxInlineStatementBytes) {
        throw new Error("An oversized D1 insert remains for public." + name + "; inspect source-field sizes before import.");
      }
      statements.push(insert);
    }
  }

  if (updateBusinessProfiles.length) {
    statements.push("", "-- Restore business-to-profile links after resolving the schema cycle.");
    statements.push(...updateBusinessProfiles);
  }
  if (restoreLargeValues.length) {
    statements.push("", "-- Restore the full original values after bounded chunk inserts.", ...restoreLargeValues);
    statements.push('DELETE FROM "_migration_import_chunks";');
  }

  const totalRows = [...rowsByTable.values()].reduce((sum, rows) => sum + rows.length, 0);
  return {
    sql: statements.join("\n") + "\n",
    manifest: {
      scope: "all public tables in the supplied PostgreSQL backup",
      publicTableCount: tables.size,
      totalRows,
      tables: Object.fromEntries([...rowsByTable.entries()].map(([name, rows]) => [name, rows.length])),
      businessIds: Object.keys(countsByBusiness).map(Number).sort((a, b) => a - b),
      businessScopedRowsByBusinessId: countsByBusiness,
      importTableOrder: tableOrder,
      largeValuesChunked: restoreLargeValues.length
    }
  };
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = fs.readFileSync(path.resolve(args.input), "utf8");
  const tables = parsePublicTables(source);
  const order = topologicalTableOrder(tables);
  const indexes = parseIndexes(source, tables);
  const exported = exportCopyData(source, tables, order);
  exported.manifest.indexCount = indexes.length;
  exported.manifest.uniqueConstraintCount = [...tables.values()].reduce((sum, table) => sum + table.uniqueConstraints.length, 0);
  exported.manifest.checkConstraintCount = [...tables.values()].reduce((sum, table) => sum + table.checkConstraints.length, 0);

  writeFile(path.resolve(args["schema-output"]), renderSchema(tables, indexes));
  writeFile(path.resolve(args["data-output"]), exported.sql);
  writeFile(path.resolve(args["manifest-output"]), JSON.stringify(exported.manifest, null, 2) + "\n");
  writeFile(path.resolve(path.join(path.dirname(args["manifest-output"]), "..", "migrations", "0001_public_schema.sql")), renderSchema(tables, indexes, false));
  writeFile(path.resolve(path.join(path.dirname(args["manifest-output"]), "..", "migrations", "0002_public_constraints.sql")), renderSupplementalConstraints(tables));

  console.log("Full public database export generated.");
  console.log("Tables: " + exported.manifest.publicTableCount + "; rows: " + exported.manifest.totalRows + ".");
  console.log("Businesses with business-scoped data: " + exported.manifest.businessIds.join(", ") + ".");
  console.log("D1 table indexes included: " + indexes.length + ".");
  console.log("Unique constraints included: " + [...tables.values()].reduce((sum, table) => sum + table.uniqueConstraints.length, 0) + ".");
  console.log("CHECK constraints preserved: " + [...tables.values()].reduce((sum, table) => sum + table.checkConstraints.length, 0) + ".");
  console.log("Schema, data, and counts written to the requested local output paths.");
  console.log("Generated data contains business and customer records; keep it local and out of source control.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
