// src/routes/unidadesVehiculos.ts
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAnyRole } from "../middleware/requireAnyRole";
import { queryDocs as query } from "../dbDocs";
import {
  UnidadCreateSchema,
  UnidadPatchSchema,
  DocumentoUnidadCreateSchema,
  DocumentoUnidadPatchSchema,
  AlertaUpsertSchema,
  PorVencerQuerySchema,
} from "../schemas/vehiculos";
import { asyncHandler } from "../utils";

const router = Router();
router.use(requireAuth, requireAnyRole(["admin"]));

/**
 * GET /vehiculos/rutas/:ruta_id/unidades
 */
router.get("/rutas/:ruta_id/unidades", asyncHandler(async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;

  const rows = await query(
    `
    SELECT
      unidad_id, ruta_id, numero, placa, marca, modelo, anio, color, km, estado, descripcion,
      creado_en, actualizado_en
    FROM unidades
    WHERE ruta_id = $1
    ORDER BY numero ASC
    `,
    [rutaId]
  );

  return res.json({ items: rows });
}));

/**
 * POST /vehiculos/rutas/:ruta_id/unidades
 */
router.post("/rutas/:ruta_id/unidades", asyncHandler(async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;

  const parsed = UnidadCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const u = parsed.data;

  // Verifica ruta existe
  const ruta = await query(`SELECT ruta_id FROM rutas WHERE ruta_id=$1`, [rutaId]);
  if (ruta.length === 0) return res.status(404).json({ ok: false, error: "RUTA_NOT_FOUND" });

  const [row] = await query<{ unidad_id: string }>(
    `
    INSERT INTO unidades (ruta_id, numero, placa, marca, modelo, anio, color, km, estado, descripcion)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING unidad_id
    `,
    [rutaId, u.numero, u.placa, u.marca, u.modelo, u.anio ?? null, u.color, u.km, u.estado, u.descripcion]
  );

  return res.status(201).json({ ok: true, unidad_id: row.unidad_id });
}));

/**
 * GET /vehiculos/unidades/:unidad_id
 */
router.get("/unidades/:unidad_id", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const rows = await query(
    `
    SELECT
      u.*,
      r.nombre AS ruta_nombre
    FROM unidades u
    JOIN rutas r ON r.ruta_id = u.ruta_id
    WHERE u.unidad_id = $1
    `,
    [unidadId]
  );

  if (rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ item: rows[0] });
}));

/**
 * PATCH /vehiculos/unidades/:unidad_id
 */
router.patch("/unidades/:unidad_id", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const parsed = UnidadPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const patch = parsed.data;

  // Column whitelist — must match DB columns exactly
  const ALLOWED_COLUMNS = new Set([
    "numero", "placa", "marca", "modelo", "anio",
    "color", "km", "estado", "descripcion",
  ]);

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!ALLOWED_COLUMNS.has(k)) continue;
    sets.push(`${k} = $${idx++}`);
    params.push(v);
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, error: "NO_FIELDS" });

  params.push(unidadId);

  const updated = await query(
    `UPDATE unidades SET ${sets.join(", ")} WHERE unidad_id = $${idx} RETURNING unidad_id`,
    params
  );

  if (updated.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
}));

/**
 * DELETE /vehiculos/unidades/:unidad_id
 */
router.delete("/unidades/:unidad_id", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const deleted = await query<{ unidad_id: string }>(
    `DELETE FROM unidades WHERE unidad_id = $1 RETURNING unidad_id`,
    [unidadId]
  );

  if (deleted.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
}));

/**
 * GET /vehiculos/unidades/:unidad_id/documentos
 * Devuelve documentos + un snapshot básico del archivo (nombre, mime, tamaño).
 */
router.get("/unidades/:unidad_id/documentos", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const rows = await query(
    `
    SELECT
      d.documento_id,
      d.unidad_id,
      d.tipo,
      d.nombre,
      d.notas,
      d.fecha_documento,
      d.vigencia_hasta,
      d.archivo_id,
      d.creado_en,
      a.nombre_original AS archivo_nombre,
      a.tipo_mime AS archivo_mime,
      a.tamanio_bytes AS archivo_bytes,
      a.estado AS archivo_estado
    FROM documentos_unidad d
    JOIN archivos a ON a.archivo_id = d.archivo_id
    WHERE d.unidad_id = $1
      AND d.eliminado_en IS NULL
    ORDER BY d.creado_en DESC
    `,
    [unidadId]
  );

  return res.json({ items: rows });
}));

/**
 * POST /vehiculos/unidades/:unidad_id/documentos
 * Crea documento apuntando a un archivo_id ya subido.
 */
router.post("/unidades/:unidad_id/documentos", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const parsed = DocumentoUnidadCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const d = parsed.data;

  // valida unidad
  const unidad = await query(`SELECT unidad_id FROM unidades WHERE unidad_id=$1`, [unidadId]);
  if (unidad.length === 0) return res.status(404).json({ ok: false, error: "UNIDAD_NOT_FOUND" });

  // valida archivo existe y está LISTO
  const archivo = await query<{ estado: string }>(
    `SELECT estado FROM archivos WHERE archivo_id=$1 AND eliminado_en IS NULL`,
    [d.archivo_id]
  );
  if (archivo.length === 0) return res.status(400).json({ ok: false, error: "ARCHIVO_NO_EXISTE" });
  if (archivo[0].estado !== "LISTO") return res.status(409).json({ ok: false, error: "ARCHIVO_NO_LISTO", estado: archivo[0].estado });

  const [row] = await query<{ documento_id: string }>(
    `
    INSERT INTO documentos_unidad (unidad_id, tipo, nombre, notas, fecha_documento, vigencia_hasta, archivo_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING documento_id
    `,
    [
      unidadId,
      d.tipo,
      d.nombre,
      d.notas ?? "",
      d.fecha_documento ?? null,
      d.vigencia_hasta ?? null,
      d.archivo_id,
    ]
  );

  return res.status(201).json({ ok: true, documento_id: row.documento_id });
}));

/**
 * PATCH /vehiculos/documentos/:documento_id
 */
router.patch("/documentos/:documento_id", asyncHandler(async (req: Request, res: Response) => {
  const documentoId = req.params.documento_id;

  const parsed = DocumentoUnidadPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const patch = parsed.data;

  // Column whitelist — must match DB columns exactly
  const ALLOWED_DOC_COLUMNS = new Set([
    "tipo", "nombre", "notas", "fecha_documento", "vigencia_hasta",
  ]);

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!ALLOWED_DOC_COLUMNS.has(k)) continue;
    sets.push(`${k} = $${idx++}`);
    params.push(v);
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, error: "NO_FIELDS" });

  params.push(documentoId);

  const updated = await query(
    `
    UPDATE documentos_unidad
    SET ${sets.join(", ")}
    WHERE documento_id = $${idx}
      AND eliminado_en IS NULL
    RETURNING documento_id
    `,
    params
  );

  if (updated.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
}));

/**
 * DELETE /vehiculos/documentos/:documento_id
 * Soft delete
 */
router.delete("/documentos/:documento_id", asyncHandler(async (req: Request, res: Response) => {
  const documentoId = req.params.documento_id;

  const updated = await query(
    `
    UPDATE documentos_unidad
    SET eliminado_en = now()
    WHERE documento_id = $1
      AND eliminado_en IS NULL
    RETURNING documento_id
    `,
    [documentoId]
  );

  if (updated.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
}));

/**
 * GET /vehiculos/unidades/:unidad_id/alertas
 */
router.get("/unidades/:unidad_id/alertas", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;

  const rows = await query(
    `
    SELECT alerta_id, unidad_id, tipo_documento, dias_antes, activa, creado_en, actualizado_en
    FROM alertas_documento
    WHERE unidad_id = $1
    ORDER BY tipo_documento ASC
    `,
    [unidadId]
  );

  return res.json({ items: rows });
}));

/**
 * PUT /vehiculos/unidades/:unidad_id/alertas/:tipo_documento
 * Upsert por (unidad_id, tipo_documento)
 */
router.put("/unidades/:unidad_id/alertas/:tipo_documento", asyncHandler(async (req: Request, res: Response) => {
  const unidadId = req.params.unidad_id;
  const tipo = req.params.tipo_documento;

  const parsed = AlertaUpsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  // valida unidad
  const unidad = await query(`SELECT unidad_id FROM unidades WHERE unidad_id=$1`, [unidadId]);
  if (unidad.length === 0) return res.status(404).json({ ok: false, error: "UNIDAD_NOT_FOUND" });

  const { dias_antes, activa } = parsed.data;

  const rows = await query(
    `
    INSERT INTO alertas_documento (unidad_id, tipo_documento, dias_antes, activa)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (unidad_id, tipo_documento)
    DO UPDATE SET dias_antes = EXCLUDED.dias_antes, activa = EXCLUDED.activa, actualizado_en = now()
    RETURNING alerta_id
    `,
    [unidadId, tipo, dias_antes, activa]
  );

  return res.json({ ok: true, alerta_id: rows[0].alerta_id });
}));

/**
 * GET /vehiculos/documentos/por-vencer?dias=30
 * Usa la view v_docs_por_vencer
 */
router.get("/documentos/por-vencer", asyncHandler(async (req: Request, res: Response) => {
  const parsed = PorVencerQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_QUERY" });

  const { dias } = parsed.data;

  const rows = await query(
    `
    SELECT *
    FROM v_docs_por_vencer
    WHERE dias_restantes <= $1
      AND dias_restantes >= 0
    ORDER BY dias_restantes ASC
    `,
    [dias]
  );

  return res.json({ items: rows, dias });
}));

export default router;
