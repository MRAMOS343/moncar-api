// src/db.ts
import { Pool, type PoolClient } from "pg";
import pg from "pg";
import fs from "fs";
import path from "path";
import { env } from "./env";

// Parse BIGINT (OID 20) -> number
// OJO: si algún día superas 2^53-1, esto pierde precisión.
pg.types.setTypeParser(20, (val) => (val === null ? null : Number.parseInt(val, 10)));

/**
 * Lee el CA cert para validar TLS contra DO Managed Postgres.
 * - Mantén el archivo FUERA de git (ya está en .gitignore).
 * - Configura DB_CA_CERT_PATH en .env.
 */
function readCaCert(): string {
  const p = process.env.DB_CA_CERT_PATH ?? "./ca-certificate.crt";
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return fs.readFileSync(abs, "utf8");
}

const sslEnabled = env.db.ssl === true;

const ssl: false | { rejectUnauthorized: true; ca: string } = sslEnabled
  ? {
      rejectUnauthorized: true, // ✅ NO permitir MITM / cert inválido
      ca: readCaCert(), // ✅ validar contra el CA
    }
  : false;

// Pool de conexión principal
export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl,
});

/**
 * Helper para consultas simples.
 *
 * health.ts lo usa así:
 *   const info = await query<{ host: string | null; db: string; user: string }>(...);
 *   const [row] = info;
 */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Helper para ejecutar una función dentro de una transacción.
 *
 * Uso típico:
 *   await withTransaction(async (client) => {
 *     await client.query(...);
 *     await client.query(...);
 *   });
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

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