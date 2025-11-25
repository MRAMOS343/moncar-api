// src/db.ts
import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  max: 10
});

// Helper para hacer queries con logs sencillos
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      level: "info",
      msg: "db.query",
      text,
      duration_ms: duration,
      rows: result.rowCount
    }));
    return result.rows as T[];
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "error",
      msg: "db.query.error",
      text,
      error: err.message
    }));
    throw err;
  }
}
