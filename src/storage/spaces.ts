import { S3Client } from "@aws-sdk/client-s3";

export const SPACES_BUCKET = mustEnv("SPACES_BUCKET");
export const SPACES_REGION = mustEnv("SPACES_REGION");
export const SPACES_ENDPOINT = mustEnv("SPACES_ENDPOINT");
export const SPACES_PREFIX = process.env.SPACES_PREFIX ?? "moncar";

export const SIGNED_URL_TTL_SECONDS = Number(process.env.SIGNED_URL_TTL_SECONDS ?? "900");

export const MULTIPART_PART_SIZE_MB = clampInt(Number(process.env.MULTIPART_PART_SIZE_MB ?? "8"), 5, 64); // S3 min 5MB
export const MULTIPART_MAX_PARTS = clampInt(Number(process.env.MULTIPART_MAX_PARTS ?? "2000"), 1, 10000);

export const s3 = new S3Client({
  region: SPACES_REGION,
  endpoint: SPACES_ENDPOINT, // ej. https://nyc3.digitaloceanspaces.com
  credentials: {
    accessKeyId: mustEnv("SPACES_KEY"),
    secretAccessKey: mustEnv("SPACES_SECRET"),
  },
});

export function buildStorageKey(params: {
  equipoId: string;
  archivoId: string;
  nombreArchivo: string;
  ahora?: Date;
}): string {
  const ahora = params.ahora ?? new Date();
  const yyyy = ahora.getUTCFullYear();
  const mm = String(ahora.getUTCMonth() + 1).padStart(2, "0");

  // Sanitiza nombre (no confíes en input)
  const safeName = sanitizeFilename(params.nombreArchivo);

  // moncar/<equipo>/YYYY/MM/<uuid>/<filename>
  return `${SPACES_PREFIX}/${params.equipoId}/${yyyy}/${mm}/${params.archivoId}/${safeName}`;
}

export function sanitizeFilename(name: string): string {
  const trimmed = String(name ?? "").trim();
  const replaced = trimmed.replace(/[^\w.\-() ]+/g, "_");
  const collapsed = replaced.replace(/\s+/g, " ");
  return collapsed.slice(0, 160) || "archivo";
}

function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Falta variable de entorno: ${key}`);
  return v;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}
