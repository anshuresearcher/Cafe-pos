#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";

const TABLE_TYPES = {
  menu: {
    id: "integer", name: "text", price: "number", category: "text",
    available: "boolean", created_at: "text", kot_group_id: "integer",
    nature: "text", unit: "text", tax_rate: "number", cgst_rate: "number",
    sgst_rate: "number", igst_rate: "number", tax_mode: "text",
    tax_label: "text", channel_prices: "json", category_id: "integer",
    image_url: "text", business_id: "integer", option_set_ids: "json",
    qr_available: "boolean", sku: "text", description: "text",
    sales_channels: "json", tags: "json", is_open_item: "boolean"
  },
  menu_categories: {
    id: "integer", name: "text", icon: "text", active: "boolean",
    sort_order: "integer", created_at: "text", updated_at: "text",
    business_id: "integer", image_url: "text"
  },
  menu_variants: {
    id: "integer", menu_id: "integer", name: "text", sku: "text",
    price: "number", unit: "text", channel_prices: "json",
    available: "boolean", created_at: "text", updated_at: "text",
    business_id: "integer", option_set_ids: "json"
  }
};

const HEADER = /^COPY public\.(menu|menu_categories|menu_variants) \((.*?)\) FROM stdin;$/;
const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseArgs(args) {
  const values = { businessIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--input" || args[index] === "--output") {
      values[args[index].slice(2)] = args[++index];
    } else if (args[index] === "--business-id") {
      values.businessIds.push(args[++index]);
    } else {
      throw new Error("Usage: node scripts/pgdump-menu-to-d1.js --input <backup.sql> --output <generated.sql> --business-id <id> [--business-id <id>]");
    }
  }
  if (!values.input || !values.output || values.businessIds.length === 0) {
    throw new Error("--input, --output, and at least one --business-id are required.");
  }
  const businessIds = values.businessIds.map(Number);
  if (businessIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Each --business-id must be a positive integer.");
  }
  values.businessIds = [...new Set(businessIds)];
  return values;
}

function unescapeCopyField(raw) {
  if (raw === "\\N") return null;
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    index += 1;
    if (index >= raw.length) {
      output += "\\";
      break;
    }
    const escaped = raw[index];
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
    if (Object.hasOwn(simple, escaped)) {
      output += simple[escaped];
    } else if (escaped === "x") {
      const match = raw.slice(index + 1, index + 3).match(/^[0-9a-fA-F]{1,2}/);
      if (match) {
        output += String.fromCharCode(parseInt(match[0], 16));
        index += match[0].length;
      } else output += "x";
    } else if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(raw[index + 1] || "")) digits += raw[++index];
      output += String.fromCharCode(parseInt(digits, 8));
    } else output += escaped;
  }
  return output;
}

function sqlLiteral(value, kind) {
  if (value === null) return "NULL";
  if (kind === "boolean") {
    if (["t", "true", "1"].includes(value.toLowerCase())) return "1";
    if (["f", "false", "0"].includes(value.toLowerCase())) return "0";
    throw new Error("Invalid PostgreSQL boolean value: " + JSON.stringify(value));
  }
  if (kind === "integer") {
    if (!INTEGER.test(value)) throw new Error("Invalid integer value: " + JSON.stringify(value));
    return value;
  }
  if (kind === "number") {
    if (!NUMBER.test(value)) throw new Error("Invalid numeric value: " + JSON.stringify(value));
    return value;
  }
  if (value.includes(String.fromCharCode(0))) throw new Error("SQLite text values cannot contain a NUL character.");
  return "'" + value.replace(/'/g, "''") + "'";
}

function readCopyData(lines, selectedBusinessIds) {
  const selected = new Set(selectedBusinessIds);
  const rowsByTable = { menu: [], menu_categories: [], menu_variants: [] };
  const seenTables = new Set();
  const countsByBusiness = new Map(
    selectedBusinessIds.map(id => [String(id), { menu: 0, menu_categories: 0, menu_variants: 0 }])
  );

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(HEADER);
    if (!match) continue;
    const table = match[1];
    seenTables.add(table);
    const columns = match[2].split(",").map(value => value.trim());
    const expected = Object.keys(TABLE_TYPES[table]);
    if (columns.length !== expected.length || expected.some(column => !columns.includes(column))) {
      throw new Error("Unexpected columns for public." + table + " at line " + (index + 1) + ".");
    }
    const businessColumn = columns.indexOf("business_id");
    index += 1;
    while (index < lines.length && lines[index] !== "\\.") {
      const rawValues = lines[index].split("\t");
      if (rawValues.length !== columns.length) {
        throw new Error("Wrong field count in public." + table + " COPY data at line " + (index + 1) + ".");
      }
      const values = rawValues.map(unescapeCopyField);
      const rowBusinessId = values[businessColumn] === null ? null : Number(values[businessColumn]);
      if (selected.has(rowBusinessId)) {
        rowsByTable[table].push({ columns, values });
        countsByBusiness.get(String(rowBusinessId))[table] += 1;
      }
      index += 1;
    }
    if (index >= lines.length) throw new Error("Missing COPY terminator after public." + table + ".");
  }

  for (const table of Object.keys(TABLE_TYPES)) {
    if (!seenTables.has(table)) throw new Error("The dump is missing public." + table + ".");
  }
  const totalItems = rowsByTable.menu.length;
  if (totalItems === 0) throw new Error("No menu items found for the selected business IDs.");
  return { rowsByTable, countsByBusiness };
}

function createSql(rowsByTable) {
  const output = [
    "-- Generated from selected public menu COPY sections only.",
    "-- Import only into the isolated D1 pilot database."
  ];
  for (const table of ["menu_categories", "menu", "menu_variants"]) {
    for (const { columns, values } of rowsByTable[table]) {
      const valuesSql = values.map((value, index) => sqlLiteral(value, TABLE_TYPES[table][columns[index]]));
      const names = columns.map(column => '"' + column + '"').join(", ");
      output.push('INSERT OR REPLACE INTO "' + table + '" (' + names + ") VALUES (" + valuesSql.join(", ") + ");");
    }
  }
  return output.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const source = fs.readFileSync(inputPath, "utf8");
  const { rowsByTable, countsByBusiness } = readCopyData(source.split(/\r?\n/), args.businessIds);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, createSql(rowsByTable), "utf8");

  console.log("Menu-only export complete for business IDs " + args.businessIds.join(", ") + ":");
  for (const table of ["menu_categories", "menu", "menu_variants"]) {
    console.log("  " + table + ": " + rowsByTable[table].length + " rows");
  }
  for (const businessId of args.businessIds) {
    const counts = countsByBusiness.get(String(businessId));
    console.log("  business_id=" + businessId + ": menu_categories=" + counts.menu_categories +
      ", menu=" + counts.menu + ", menu_variants=" + counts.menu_variants);
  }
  console.log("Generated file: " + outputPath);
  console.log("Keep this generated data file out of source control.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
