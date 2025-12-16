// src/db.ts
import { Pool, type PoolClient } from "pg";
import { env } from "./env";
import pg from "pg";


pg.types.setTypeParser(20, (val) => (val === null ? null : Number.parseInt(val, 10)));



// Pool de conexión principal
export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  // Forzar SSL sin rechazar el certificado “self-signed”
  ssl: {
    rejectUnauthorized: false,
  },
});



/**
 * Helper para consultas simples.
 *
 * health.ts lo usa así:
 *   const info = await query<{ host: string | null; db: string; user: string }>(...);
 *   const [row] = info;
 */
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
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
