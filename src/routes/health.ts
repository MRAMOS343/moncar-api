// src/routes/health.ts
import { Router } from "express";
import { Pool } from "pg";

const router = Router();

// Pool global reutilizable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

router.get("/health/db", async (_req, res) => {
  const inicio = Date.now();
  try {
    await pool.query("SELECT 1");
    const duracionMs = Date.now() - inicio;

    return res.json({
      ok: true,
      db: "up",
      duration_ms: duracionMs,
    });
  } catch (error) {
    console.error("[/health/db] Error al consultar la base:", error);
    return res.status(500).json({
      ok: false,
      db: "down",
      error: "No se pudo consultar la base de datos",
    });
  }
});

export default router;

