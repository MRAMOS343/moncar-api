// src/index.ts
import "dotenv/config";
import express, { Router } from "express";
import cors from "cors";
import helmet from "helmet";

import ventasRouter from "./routes/ventas";
import healthRouter from "./routes/health";
import inventarioRouter from "./routes/inventario";
import fichasRouter from "./routes/fichasTecnicas";
import authRouter from "./routes/auth";
import warehousesRouter from "./routes/warehouses";
import productosRouter from "./routes/productos";
import cancelacionesRouter from "./routes/cancelaciones";
import equiposRouter from "./routes/equipos";
import usuariosRouter from "./routes/usuarios";
import settingsRouter from "./routes/settings";
import usersMeRouter from "./routes/usersMe";
import debugRouter from "./routes/debug";
import invitacionesRouter from "./routes/invitaciones";
import testEmailRouter from "./routes/testEmail";
import salesReportRouter from "./routes/salesReport";
import prediccionRouter from "./routes/prediccion";
import compraSugeridaRouter from "./routes/compraSugerida";

import { startPrediccionJob } from "./jobs/prediccionJob";
import { startCompraSugeridaJob } from "./jobs/compraSugeridaJob";
import { logger } from "./logger";
import { authLimiter, apiLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import { pool } from "./db";
import { poolDocs } from "./dbDocs";

// RENTAS

// DOCUMENTOS
import archivosRouter from "./routes/archivos";
import rutasVehiculosRouter from "./routes/rutasVehiculos";
import unidadesVehiculosRouter from "./routes/unidadesVehiculos";

const app = express();

// === Security Headers ===
app.use(helmet());

// CORS (allowlist por env: ALLOWED_ORIGINS="https://...,http://localhost:5173")
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman sin Origin
      const allowed = allowedOrigins.some(o =>
        o.includes("*")
          ? new RegExp("^" + o.replace(/\*/g, ".*") + "$").test(origin)
          : o === origin
      );
      if (allowed) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Body parsing con límite para prevenir payload bombing
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Rate limiting
app.use("/auth/login", authLimiter);
app.use(apiLimiter);

// === API v1 Router ===
const v1 = Router();

// POS
v1.use(salesReportRouter);  // antes de ventasRouter para evitar colisión con /sales/:venta_id
v1.use(ventasRouter);
v1.use(healthRouter);
v1.use(inventarioRouter);
v1.use(debugRouter);
v1.use(fichasRouter);
v1.use(authRouter);
v1.use(warehousesRouter);
v1.use(productosRouter);
v1.use(cancelacionesRouter);
v1.use(equiposRouter);
v1.use(usuariosRouter);
v1.use(settingsRouter);
v1.use(usersMeRouter);
v1.use(invitacionesRouter);
v1.use(testEmailRouter);
v1.use(prediccionRouter);
v1.use(compraSugeridaRouter);

// RENTAS

// Documentos
v1.use("/archivos", archivosRouter);
v1.use("/vehiculos", rutasVehiculosRouter);
v1.use("/vehiculos", unidadesVehiculosRouter);

// Montar v1 en /api/v1
app.use("/api/v1", v1);

// Compat: también montar en raíz (deprecar gradualmente)
// Adds Deprecation header to signal clients should migrate to /api/v1
app.use((_req, res, next) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "2025-12-31");
  res.setHeader("Link", '</api/v1>; rel="successor-version"');
  next();
});
app.use(ventasRouter);
app.use(healthRouter);
app.use(inventarioRouter);
app.use(debugRouter);
app.use(fichasRouter);
app.use(authRouter);
app.use(warehousesRouter);
app.use(productosRouter);
app.use(cancelacionesRouter);
app.use(equiposRouter);
app.use(usuariosRouter);
app.use(settingsRouter);
app.use(usersMeRouter);
app.use("/archivos", archivosRouter);
app.use("/vehiculos", rutasVehiculosRouter);
app.use("/vehiculos", unidadesVehiculosRouter);

app.get("/ping", (_req, res) => {
  res.json({ ok: true, message: "pong", now: new Date().toISOString() });
});

// Error handler global (DEBE ir después de todos los routers)
app.use(errorHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

startPrediccionJob();
startCompraSugeridaJob();

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "server.started");
});

// === Graceful Shutdown ===
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, "shutdown.initiated");

  server.close(async () => {
    logger.info("http.closed");

    try {
      await pool.end();
      logger.info("db.pool.closed");
    } catch (err) {
      logger.error({ err }, "db.pool.close.error");
    }

    try {
      await poolDocs.end();
      logger.info("db.poolDocs.closed");
    } catch (err) {
      logger.error({ err }, "db.poolDocs.close.error");
    }

    logger.info("shutdown.complete");
    process.exit(0);
  });

  // Forzar cierre después de 10s
  setTimeout(() => {
    logger.error("shutdown.timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
