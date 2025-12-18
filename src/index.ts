// src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

import ventasRouter from "./routes/ventas";
import healthRouter from "./routes/health";
import inventarioRouter from "./routes/inventario";
import fichasRouter from "./routes/fichas-tecnicas";
import authRouter from "./routes/auth";



import { logger } from './logger';
import debugRouter from './routes/debug';

const app = express();

// Middlewares básicos
app.use(cors());
app.use(express.json());

// Rutas principales
app.use(ventasRouter);
app.use(healthRouter);
app.use(inventarioRouter);
app.use(debugRouter);
app.use(fichasRouter);
app.use(authRouter);



// Endpoint de diagnóstico rápido
app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    message: "pong",
    now: new Date().toISOString(),
  });
});

// Puerto
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// Levantar servidor HTTP
app.listen(PORT, () => {
  console.log(`API escuchando en puerto ${PORT}`);
});

app.listen(PORT, () => {
  logger.info({ msg: 'server.started',PORT});
});

export default app;

