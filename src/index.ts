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
import rentasHealthRouter from "./routes/rentasHealth";
import rentasPropiedadesRouter from "./routes/rentasPropiedades";
import rentasContratosRouter from "./routes/rentasContratos";
import rentasPagosRouter from "./routes/rentasPagos";


// DOCUMENTOS
import archivosRouter from "./routes/archivos";


const app = express();

app.use(cors());
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
app.use(rentasHealthRouter);
app.use(rentasPropiedadesRouter);
app.use(rentasContratosRouter);
app.use(rentasPagosRouter);

//Documentos
app.use("/archivos", archivosRouter);

app.get("/ping", (_req, res) => {
  res.json({ ok: true, message: "pong", now: new Date().toISOString() });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(PORT, () => {
  logger.info({ msg: "server.started", PORT });
  console.log(`API escuchando en puerto ${PORT}`);
});

export default app;

