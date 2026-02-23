// src/dbDocs.ts
import { Pool, type PoolClient } from "pg";

function mustEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Falta variable de entorno: ${k}`);
  return v;
}

export const poolDocs = new Pool({
  host: mustEnv("DOCS_DB_HOST"),
  port: Number(mustEnv("DOCS_DB_PORT")),
  user: mustEnv("DOCS_DB_USER"),
  password: mustEnv("DOCS_DB_PASSWORD"),
  database: mustEnv("DOCS_DB_NAME"),
  ssl: { rejectUnauthorized: false },
});

export async function queryDocs<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await poolDocs.query(text, params);
  return result.rows as T[];
}

export async function withTransactionDocs<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
