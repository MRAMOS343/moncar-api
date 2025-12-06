// src/index.ts
import express from "express";
import { env } from "./env";
import healthRouter from "./routes/health";
import ventasRouter from "./routes/ventas";
import inventarioRouter from "./routes/inventario"; // 


const app = express();

// Middleware para JSON
app.use(express.json());

// Rutas
app.use(healthRouter);
app.use(ventasRouter);
app.use(inventarioRouter); // 


// Puerto
const port = env.port || 4000;

app.listen(port, () => {
  console.log(`API escuchando en puerto ${port}`);
});
