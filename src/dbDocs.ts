// src/dbDocs.ts

import { Pool, type PoolClient } from "pg";
import fs from "fs";
import path from "path";
import { env } from "./env";

/**
 * Lee el CA cert para TLS hacia la DB de documentos/vehículos.
 * - Primero intenta DOCS_DB_CA_CERT_PATH (específico para docs).
 * - Luego cae a DB_CA_CERT_PATH (general).
 * - Finalmente usa ./ca-certificate.crt relativo al working dir.
 */
function readCaCert(): string {
  const p =
    process.env.DOCS_DB_CA_CERT_PATH ??
    process.env.DB_CA_CERT_PATH ??
    "./ca-certificate.crt";

  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return fs.readFileSync(abs, "utf8");
}

const ssl: false | { rejectUnauthorized: true; ca: string } = env.docsDb.ssl
  ? { rejectUnauthorized: true, ca: readCaCert() }
  : false;

/**
 * Pool dedicado para la base de datos de documentos/vehículos.
 * OJO: usa env.docsDb (NO env.db).
 */
export const poolDocs = new Pool({
  host: env.docsDb.host,
  port: env.docsDb.port,
  user: env.docsDb.user,
  password: env.docsDb.password,
  database: env.docsDb.database,
  ssl,
});

export async function queryDocs<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
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
