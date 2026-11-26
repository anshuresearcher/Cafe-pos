import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

const globalForDb = globalThis as typeof globalThis & { cafePosPool?: Pool };

function sslConfig() {
  const file = String(process.env.DATABASE_SSL_CA_FILE || "").trim();
  if (file) {
    return { ca: fs.readFileSync(path.resolve(file), "utf8"), rejectUnauthorized: true };
  }
  const ca = String(process.env.DATABASE_SSL_CA || "").trim();
  return ca ? { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true } : undefined;
}

function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 2),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 8000),
      ssl: sslConfig(),
    });
  }

  return new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    max: Number(process.env.DB_POOL_MAX || 2),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 8000),
  });
}

export const db = globalForDb.cafePosPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDb.cafePosPool = db;
}

export async function withTenant<T>(businessId: number, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.business_id', $1, true), set_config('app.system_mode', 'off', true)", [String(businessId)]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withSystem<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.business_id', '', true), set_config('app.system_mode', 'on', true)");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
