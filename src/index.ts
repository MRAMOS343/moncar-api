// src/index.ts
import express from "express";
import { env } from "./env";
import { pool, query } from "./db";
import healthRouter from "./routes/health";

const app = express();

// Para leer JSON
app.use(express.json());
app.use(healthRouter);

// Log muy simple de cada request
app.use((req, _res, next) => {
  console.log(JSON.stringify({
    level: "info",
    msg: "http.request",
    method: req.method,
    path: req.path
  }));
  next();
});

// Health check básico
app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Readiness: comprueba conexión a la base
app.get("/readiness", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ready" });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ status: "db_error" });
  }
});

// Stub para importación de ventas (lo llenaremos después)
app.post("/ventas/import-batch", async (req, res) => {
  const body = req.body;

  if (!Array.isArray(body)) {
    return res.status(400).json({ error: "Se esperaba un arreglo de ventas" });
  }

  console.log(JSON.stringify({
    level: "info",
    msg: "ventas.import-batch.received",
    items: body.length
  }));

  // Más adelante aquí haremos el UPSERT a tablas ventas + líneas + pagos
  return res.json({ ok: body.length, dup: 0, error: 0, errors: [] });
});

// Arrancar servidor
app.listen(env.port, async () => {
  try {
    // Probar conexión inicial
    await pool.query("SELECT 1");
    console.log(JSON.stringify({
      level: "info",
      msg: "api.started",
      port: env.port,
      db: env.db.database
    }));
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "error",
      msg: "api.db_connection_failed",
      error: err.message
    }));
    process.exit(1);
  }
});
