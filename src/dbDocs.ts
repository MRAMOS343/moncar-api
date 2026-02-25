// src/dbDocs.ts
import { Pool, type PoolClient } from "pg";
import fs from "fs";
import path from "path";
import { env } from "./env";

function readCaCert(): string {
  const p = process.env.DB_CA_CERT_PATH ?? "./ca-certificate.crt";
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return fs.readFileSync(abs, "utf8");
}

const ssl: false | { rejectUnauthorized: true; ca: string } = env.db.ssl
  ? { rejectUnauthorized: true, ca: readCaCert() }
  : false;

export const poolDocs = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl,
});

export async function queryDocs<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await poolDocs.query(text, params);
  return result.rows as T[];
}

export async function withTransactionDocs<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await poolDocs.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}