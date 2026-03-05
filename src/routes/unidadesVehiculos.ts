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
  ImportarRutaSchema,
} from "../schemas/vehiculos";
import { asyncHandler, HttpError } from "../utils";
import { withTransactionDocs } from "../dbDocs";
import { logger } from "../logger";

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

// ── Bulk Import Endpoints ─────────────────────────────────────────────

/**
 * GET /vehiculos/rutas/:ruta_id/unidades/check?numeros=07,15,16
 * Verifica cuáles de los números de unidad ya existen en la ruta.
 */
router.get("/rutas/:ruta_id/unidades/check", asyncHandler(async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;
  const numeros = String(req.query.numeros ?? "")
    .split(",")
    .map(n => n.trim())
    .filter(Boolean);

  if (numeros.length === 0) {
    return res.json({ ok: true, duplicados: [] });
  }

  const rows = await query<{ numero: string }>(
    `SELECT numero FROM unidades
     WHERE ruta_id = $1 AND numero = ANY($2)`,
    [rutaId, numeros]
  );

  return res.json({
    ok: true,
    duplicados: rows.map(r => r.numero),
  });
}));

/**
 * POST /vehiculos/rutas/:ruta_id/importar
 * Importación masiva: crea unidades + asocia documentos ya subidos, en una sola transacción.
 *
 * Body: { unidades: [{ numero, placa?, marca?, modelo?, documentos: [{ archivo_id, tipo, nombre, vigencia_hasta? }] }],
 *         omitir_duplicados?: boolean }
 */
router.post("/rutas/:ruta_id/importar", asyncHandler(async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;

  // Verificar que la ruta existe
  const ruta = await query(`SELECT ruta_id FROM rutas WHERE ruta_id = $1`, [rutaId]);
  if (ruta.length === 0) throw new HttpError(404, "RUTA_NOT_FOUND");

  // Validar body
  const parsed = ImportarRutaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: parsed.error.flatten() });
  }

  const { unidades, omitir_duplicados } = parsed.data;

  const resultado = {
    creadas:  [] as string[],
    omitidas: [] as string[],
    errores:  [] as { numero: string; error: string }[],
  };

  await withTransactionDocs(async (client) => {
    for (const unidad of unidades) {
      // ¿Ya existe esta unidad en esta ruta?
      const { rows: existentes } = await client.query(
        "SELECT unidad_id FROM unidades WHERE ruta_id = $1 AND numero = $2",
        [rutaId, unidad.numero]
      );

      if (existentes.length > 0) {
        if (omitir_duplicados) {
          resultado.omitidas.push(unidad.numero);
          continue;
        } else {
          throw new HttpError(409, `UNIDAD_DUPLICADA:${unidad.numero}`);
        }
      }

      // SAVEPOINT para poder recuperarnos si falla el INSERT sin romper la transacción
      const sp = `sp_unidad_${unidad.numero.replace(/\W/g, "_")}`;
      await client.query(`SAVEPOINT ${sp}`);

      // Crear la unidad (mismas columnas que el endpoint individual POST /rutas/:ruta_id/unidades)
      let unidadId: string;
      try {
        const { rows } = await client.query(
          `INSERT INTO unidades
             (ruta_id, numero, placa, marca, modelo, anio, color, km, estado, descripcion)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'activa', '')
           RETURNING unidad_id`,
          [
            rutaId,
            unidad.numero,
            unidad.placa || null,  // NULL para no violar UNIQUE constraint con strings vacíos
            unidad.marca ?? "",
            unidad.modelo ?? "",
            null,  // anio
            "",    // color
            0,     // km
          ]
        );
        unidadId = rows[0].unidad_id;
      } catch (err: any) {
        // En PG, tras un error el tx queda "aborted" — ROLLBACK TO SAVEPOINT lo restaura
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        const pgMsg = err?.message ?? "desconocido";
        logger.warn({ numero: unidad.numero, pgError: pgMsg }, "vehiculos.bulk_import.insert_failed");
        resultado.errores.push({ numero: unidad.numero, error: `Error creando la unidad: ${pgMsg}` });
        continue;
      }

      // Asociar cada documento ya subido a esta unidad
      for (const doc of unidad.documentos) {
        // Verificar que el archivo_id existe
        const { rows: archivoRows } = await client.query(
          "SELECT archivo_id FROM archivos WHERE archivo_id = $1 AND eliminado_en IS NULL",
          [doc.archivo_id]
        );

        if (archivoRows.length === 0) {
          resultado.errores.push({
            numero: unidad.numero,
            error: `archivo_id ${doc.archivo_id} no encontrado`,
          });
          continue;
        }

        await client.query(
          `INSERT INTO documentos_unidad
             (unidad_id, tipo, nombre, notas, fecha_documento, vigencia_hasta, archivo_id)
           VALUES ($1, $2, $3, '', NULL, $4, $5)`,
          [
            unidadId,
            doc.tipo,
            doc.nombre,
            doc.vigencia_hasta ?? null,
            doc.archivo_id,
          ]
        );
      }

      // Liberar savepoint si todo fue bien
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      resultado.creadas.push(unidad.numero);
    }
  });

  logger.info({
    rutaId,
    creadas:  resultado.creadas.length,
    omitidas: resultado.omitidas.length,
    errores:  resultado.errores.length,
  }, "vehiculos.bulk_import.done");

  return res.status(201).json({
    ok: true,
    ...resultado,
    resumen: `${resultado.creadas.length} unidades creadas, ${resultado.omitidas.length} omitidas, ${resultado.errores.length} errores`,
  });
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
