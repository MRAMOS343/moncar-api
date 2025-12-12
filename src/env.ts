// src/env.ts
import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta variable de entorno: ${name}`);
  }
  return value;
}

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  db: {
    host: required("DB_HOST"),
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    ssl: process.env.DB_SSL === "true",
  },
  jwt: {
   
    secret: process.env.JWT_SECRET || "monzopachuca",
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },
};

