// src/routes/archivos.ts
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { requireAuth } from "../middleware/requireAuth";
import { query } from "../db";

import {
  s3,
  SPACES_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  MULTIPART_PART_SIZE_MB,
  MULTIPART_MAX_PARTS,
  buildStorageKey,
  sanitizeFilename,
} from "../storage/spaces";

import { ArchivoInitSchema, ParteUrlSchema, CompletarSchema } from "../schemas/archivos";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = Router();

function archivosEnabled(): boolean {
  return String(process.env.FILES_ENABLED ?? "").toLowerCase() === "true";
}

const MIMES_PERMITIDOS = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/msword", // doc
  "application/vnd.ms-excel", // xls
]);

function getSucursalId(req: Request): string {
  // Tu repo usa req.user.sucursal_id en requireAuth.
  // Si estás en modo single-store, puedes forzar con FORCED_SUCURSAL_ID.
  return (req as any).user?.sucursal_id ?? (process.env.FORCED_SUCURSAL_ID ?? "moncar");
}

function getUsuarioId(req: Request): string | null {
  return (req as any).user?.id ?? null;
}

/**
 * POST /archivos/init
 */
router.post("/init", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const parsed = ArchivoInitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST", details: parsed.error.flatten() });

  const sucursalId = getSucursalId(req);
  const usuarioId = getUsuarioId(req);

  const data = parsed.data;

  if (!MIMES_PERMITIDOS.has(data.tipo_mime)) {
    return res.status(400).json({ error: "TIPO_MIME_NO_PERMITIDO" });
  }

  const archivoId = randomUUID();
  const nombreGuardado = sanitizeFilename(data.nombre_original);

  const storageKey = buildStorageKey({
    equipoId: sucursalId,
    archivoId,
    nombreArchivo: nombreGuardado,
  });

  const parteBytes = MULTIPART_PART_SIZE_MB * 1024 * 1024;
  const partesTotales = Math.ceil(data.tamanio_bytes / parteBytes);

  if (partesTotales > MULTIPART_MAX_PARTS) {
    return res.status(400).json({
      error: "DEMASIADAS_PARTES",
      detalles: { partesTotales, limite: MULTIPART_MAX_PARTS, parteBytes },
    });
  }

  await query(
    `INSERT INTO archivos(
      archivo_id, equipo_id, usuario_id,
      nombre_original, nombre_guardado, tipo_mime, extension, tamanio_bytes,
      carpeta_logica, etiquetas,
      clave_objeto, bucket, region, endpoint,
      partes_totales, parte_bytes,
      estado
    )
    VALUES (
      $1,$2,$3,
      $4,$5,$6,$7,$8,
      $9,$10,
      $11,$12,$13,$14,
      $15,$16,
      'INICIADO'
    )`,
    [
      archivoId, sucursalId, usuarioId,
      data.nombre_original, nombreGuardado, data.tipo_mime, extFromName(nombreGuardado), data.tamanio_bytes,
      data.carpeta_logica ?? null, data.etiquetas ?? [],
      storageKey, process.env.SPACES_BUCKET, process.env.SPACES_REGION, process.env.SPACES_ENDPOINT,
      partesTotales, parteBytes,
    ]
  );

  const create = await s3.send(new CreateMultipartUploadCommand({
    Bucket: SPACES_BUCKET,
    Key: storageKey,
    ContentType: data.tipo_mime,
    Metadata: { archivo_id: archivoId, sucursal_id: sucursalId },
  }));

  const uploadId = create.UploadId;
  if (!uploadId) return res.status(500).json({ error: "NO_UPLOAD_ID" });

  await query(
    `UPDATE archivos
     SET multipart_upload_id=$1, estado='SUBIENDO', actualizado_en=now()
     WHERE archivo_id=$2`,
    [uploadId, archivoId]
  );

  return res.json({
    archivo_id: archivoId,
    upload_id: uploadId,
    clave_objeto: storageKey,
    parte_bytes: parteBytes,
    partes_totales: partesTotales,
    expires_in_seconds: SIGNED_URL_TTL_SECONDS,
  });
});

/**
 * POST /archivos/:archivo_id/parte-url
 */
router.post("/:archivo_id/parte-url", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const parsed = ParteUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST", details: parsed.error.flatten() });

  const sucursalId = getSucursalId(req);
  const archivoId = req.params.archivo_id;
  const { numero_parte } = parsed.data;

  const rows = await query<{ clave_objeto: string; multipart_upload_id: string | null; estado: string }>(
    `SELECT clave_objeto, multipart_upload_id, estado
     FROM archivos
     WHERE archivo_id=$1 AND equipo_id=$2 AND eliminado_en IS NULL`,
    [archivoId, sucursalId]
  );

  if (rows.length === 0) return res.status(404).json({ error: "NO_ENCONTRADO" });

  const row = rows[0];
  if (row.estado !== "SUBIENDO") return res.status(409).json({ error: "ESTADO_INVALIDO", estado: row.estado });
  if (!row.multipart_upload_id) return res.status(500).json({ error: "UPLOAD_ID_FALTANTE" });

  const cmd = new UploadPartCommand({
    Bucket: SPACES_BUCKET,
    Key: row.clave_objeto,
    UploadId: row.multipart_upload_id,
    PartNumber: numero_parte,
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_TTL_SECONDS });
  return res.json({ url });
});

/**
 * POST /archivos/:archivo_id/completar
 */
router.post("/:archivo_id/completar", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const parsed = CompletarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST", details: parsed.error.flatten() });

  const sucursalId = getSucursalId(req);
  const archivoId = req.params.archivo_id;

  const rows = await query<{
    clave_objeto: string;
    multipart_upload_id: string | null;
    tipo_mime: string;
    tamanio_bytes: string | number;
    estado: string;
  }>(
    `SELECT clave_objeto, multipart_upload_id, tipo_mime, tamanio_bytes, estado
     FROM archivos
     WHERE archivo_id=$1 AND equipo_id=$2 AND eliminado_en IS NULL`,
    [archivoId, sucursalId]
  );

  if (rows.length === 0) return res.status(404).json({ error: "NO_ENCONTRADO" });

  const file = rows[0];
  if (file.estado !== "SUBIENDO") return res.status(409).json({ error: "ESTADO_INVALIDO", estado: file.estado });
  if (!file.multipart_upload_id) return res.status(500).json({ error: "UPLOAD_ID_FALTANTE" });

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: SPACES_BUCKET,
    Key: file.clave_objeto,
    UploadId: file.multipart_upload_id,
    MultipartUpload: {
      Parts: parsed.data.partes
        .sort((a, b) => a.numero_parte - b.numero_parte)
        .map(p => ({ PartNumber: p.numero_parte, ETag: p.etag })),
    },
  }));

  const head = await s3.send(new HeadObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: file.clave_objeto,
  }));

  const actualSize = Number(head.ContentLength ?? 0);
  const expectedSize = Number(file.tamanio_bytes);

  if (actualSize <= 0) {
    await query(`UPDATE archivos SET estado='ERROR', actualizado_en=now() WHERE archivo_id=$1`, [archivoId]);
    return res.status(400).json({ error: "ARCHIVO_NO_VALIDO" });
  }

  if (Math.abs(actualSize - expectedSize) > 1024) {
    await query(`UPDATE archivos SET estado='ERROR', actualizado_en=now() WHERE archivo_id=$1`, [archivoId]);
    return res.status(400).json({ error: "TAMANIO_NO_COINCIDE", esperado: expectedSize, actual: actualSize });
  }

  const etag = typeof head.ETag === "string" ? head.ETag : null;

  await query(
    `UPDATE archivos
     SET estado='LISTO', verificado_en=now(), etag=$2, actualizado_en=now()
     WHERE archivo_id=$1`,
    [archivoId, etag]
  );

  return res.json({ ok: true, tamanio_bytes: actualSize });
});

/**
 * GET /archivos
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const sucursalId = getSucursalId(req);
  const limit = Math.min(Number(req.query.limit ?? "30"), 100);

  const items = await query(
    `SELECT
       archivo_id, nombre_original, tipo_mime, tamanio_bytes,
       carpeta_logica, etiquetas, estado, creado_en
     FROM archivos
     WHERE equipo_id=$1 AND eliminado_en IS NULL
     ORDER BY creado_en DESC
     LIMIT $2`,
    [sucursalId, limit]
  );

  return res.json({ items });
});

/**
 * GET /archivos/:archivo_id/descargar
 */
router.get("/:archivo_id/descargar", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const sucursalId = getSucursalId(req);
  const archivoId = req.params.archivo_id;

  const rows = await query<{ clave_objeto: string; nombre_original: string; tipo_mime: string; estado: string }>(
    `SELECT clave_objeto, nombre_original, tipo_mime, estado
     FROM archivos
     WHERE archivo_id=$1 AND equipo_id=$2 AND eliminado_en IS NULL`,
    [archivoId, sucursalId]
  );

  if (rows.length === 0) return res.status(404).json({ error: "NO_ENCONTRADO" });

  const file = rows[0];
  if (file.estado !== "LISTO") return res.status(409).json({ error: "NO_LISTO", estado: file.estado });

  const cmd = new GetObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: file.clave_objeto,
    ResponseContentDisposition: `inline; filename="${encodeURIComponent(file.nombre_original)}"`,
    ResponseContentType: file.tipo_mime,
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_TTL_SECONDS });
  return res.json({ url, expires_in_seconds: SIGNED_URL_TTL_SECONDS });
});

/**
 * DELETE /archivos/:archivo_id
 */
router.delete("/:archivo_id", requireAuth, async (req: Request, res: Response) => {
  if (!archivosEnabled()) return res.status(503).json({ error: "ARCHIVOS_DESHABILITADOS" });

  const sucursalId = getSucursalId(req);
  const archivoId = req.params.archivo_id;

  const rows = await query<{ clave_objeto: string; multipart_upload_id: string | null; estado: string }>(
    `SELECT clave_objeto, multipart_upload_id, estado
     FROM archivos
     WHERE archivo_id=$1 AND equipo_id=$2 AND eliminado_en IS NULL`,
    [archivoId, sucursalId]
  );

  if (rows.length === 0) return res.status(404).json({ error: "NO_ENCONTRADO" });

  const file = rows[0];

  await query(
    `UPDATE archivos
     SET eliminado_en=now(), estado='ELIMINADO', actualizado_en=now()
     WHERE archivo_id=$1`,
    [archivoId]
  );

  try {
    if (file.estado === "SUBIENDO" && file.multipart_upload_id) {
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: SPACES_BUCKET,
        Key: file.clave_objeto,
        UploadId: file.multipart_upload_id,
      }));
    }
    await s3.send(new DeleteObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: file.clave_objeto,
    }));
  } catch (e) {
    console.warn(JSON.stringify({ evt: "archivos.delete_warn", archivo_id: archivoId, err: String(e) }));
  }

  return res.json({ ok: true });
});

export default router;

function extFromName(name: string): string | null {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : null;
}
