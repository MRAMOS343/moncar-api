// src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

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

import { logger } from "./logger";

// RENTAS

// DOCUMENTOS
import archivosRouter from "./routes/archivos";
import rutasVehiculosRouter from "./routes/rutasVehiculos";
import unidadesVehiculosRouter from "./routes/unidadesVehiculos";

const app = express();

// CORS (allowlist por env: ALLOWED_ORIGINS="https://...,http://localhost:5173")
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman sin Origin
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

// POS
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

// RENTAS

// Documentos
app.use("/archivos", archivosRouter);
app.use("/vehiculos", rutasVehiculosRouter);
app.use("/vehiculos", unidadesVehiculosRouter);

app.get("/ping", (_req, res) => {
  res.json({ ok: true, message: "pong", now: new Date().toISOString() });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(PORT, () => {
  logger.info({ msg: "server.started", PORT });
  console.log(`API escuchando en puerto ${PORT}`);
});

export default app;
