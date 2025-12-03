import { Router } from "express";
import { query } from "../db";

const router = Router();

router.get("/health/db", async (_req, res) => {
  const inicio = Date.now();
  try {
    await query("SELECT 1");
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

