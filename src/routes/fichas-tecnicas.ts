// src/routes/fichas-tecnicas.ts
import express from "express";
import { z } from "zod";
import { query } from "../db";
import { logger } from "../logger";
import { requireAuth, requireRole } from "../middleware/auth";

const router = express.Router();

// Body para crear/actualizar la ficha (header)
const FichaUpsertSchema = z.object({
  notas_generales: z.string().max(2000).optional(),
});

// Un atributo (material, voltaje, etc.)
const AtributoSchema = z.object({
  nombre_atributo: z.string().min(1),
  valor: z.string().min(1),
  unidad: z.string().max(50).optional(),
});

// Body para upsert batch de atributos
const AtributosUpsertSchema = z.object({
  atributos: z.array(AtributoSchema).min(1),
});

/**
 * GET /productos/:sku/ficha-tecnica
 * Devuelve la ficha técnica y sus atributos.
 * Requiere estar autenticado (cualquier rol).
 */
router.get(
  "/productos/:sku/ficha-tecnica",
  requireAuth,
  async (req, res) => {
    const { sku } = req.params;

    try {
      logger.info({ msg: "fichas.get", sku });

      const fichaRows = await query<{
        id: number;
        sku: string;
        notas_generales: string | null;
      }>(
        "SELECT id, sku, notas_generales FROM fichas_tecnicas WHERE sku = $1",
        [sku],
      );

      if (fichaRows.length === 0) {
        return res.status(404).json({ ok: false, reason: "NOT_FOUND" });
      }

      const ficha = fichaRows[0];

      const attrsRows = await query<{
        id: number;
        nombre_atributo: string;
        valor: string;
        unidad: string | null;
        creado_por: number | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, nombre_atributo, valor, unidad, creado_por, created_at, updated_at
         FROM fichas_tecnicas_atributos
         WHERE ficha_id = $1
         ORDER BY nombre_atributo ASC`,
        [ficha.id],
      );

      return res.json({
        ok: true,
        sku: ficha.sku,
        notas_generales: ficha.notas_generales,
        atributos: attrsRows,
      });
    } catch (err) {
      logger.error({ msg: "fichas.get.error", sku, err });
      return res.status(500).json({ ok: false, reason: "INTERNAL_ERROR" });
    }
  },
);

/**
 * PUT /productos/:sku/ficha-tecnica
 * Crea/actualiza la ficha (notas_generales). Idempotente por sku.
 * Requiere rol admin.
 */
router.put(
  "/productos/:sku/ficha-tecnica",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const { sku } = req.params;
    const parse = FichaUpsertSchema.safeParse(req.body);

    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        reason: "INVALID_BODY",
        details: parse.error.flatten(),
      });
    }

    const { notas_generales } = parse.data;

    try {
      logger.info({ msg: "fichas.upsert", sku });

      const rows = await query<{
        id: number;
        sku: string;
        notas_generales: string | null;
      }>(
        `INSERT INTO fichas_tecnicas (sku, notas_generales)
         VALUES ($1, $2)
         ON CONFLICT (sku)
         DO UPDATE SET
           notas_generales = EXCLUDED.notas_generales,
           updated_at = now()
         RETURNING id, sku, notas_generales`,
        [sku, notas_generales ?? null],
      );

      const ficha = rows[0];

      return res.json({
        ok: true,
        sku: ficha.sku,
        ficha_id: ficha.id,
        notas_generales: ficha.notas_generales,
      });
    } catch (err) {
      logger.error({ msg: "fichas.upsert.error", sku, err });
      return res.status(500).json({ ok: false, reason: "INTERNAL_ERROR" });
    }
  },
);

/**
 * PUT /productos/:sku/ficha-tecnica/atributos
 * Upsert en batch de atributos. Crea ficha si no existe.
 * Requiere rol admin.
 */
router.put(
  "/productos/:sku/ficha-tecnica/atributos",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const { sku } = req.params;
    const parse = AtributosUpsertSchema.safeParse(req.body);

    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        reason: "INVALID_BODY",
        details: parse.error.flatten(),
      });
    }

    const { atributos } = parse.data;
    const userId = (req as any).user?.id ?? null;

    try {
      logger.info({
        msg: "fichas.atributos.upsert",
        sku,
        count: atributos.length,
      });

      // Asegurar que exista la ficha y obtener id
      const fichaRows = await query<{ id: number }>(
        `INSERT INTO fichas_tecnicas (sku)
         VALUES ($1)
         ON CONFLICT (sku)
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [sku],
      );

      const fichaId = fichaRows[0].id;
      let upserted = 0;

      for (const attr of atributos) {
        const nombreNormalizado = attr.nombre_atributo.trim().toLowerCase();

        // 1) Ver si ya existe ese atributo para esta ficha
        const existing = await query<{ id: number }>(
          `SELECT id
           FROM fichas_tecnicas_atributos
           WHERE ficha_id = $1 AND nombre_atributo = $2`,
          [fichaId, nombreNormalizado],
        );

        if (existing.length === 0) {
          // 2a) No existe → INSERT
          await query(
            `INSERT INTO fichas_tecnicas_atributos
               (ficha_id, nombre_atributo, valor, unidad, creado_por)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              fichaId,
              nombreNormalizado,
              attr.valor,
              attr.unidad ?? null,
              userId,
            ],
          );
        } else {
          // 2b) Sí existe → UPDATE
          await query(
            `UPDATE fichas_tecnicas_atributos
             SET valor = $3,
                 unidad = $4,
                 updated_at = now()
             WHERE ficha_id = $1
               AND nombre_atributo = $2`,
            [
              fichaId,
              nombreNormalizado,
              attr.valor,
              attr.unidad ?? null,
            ],
          );
        }

        upserted += 1;
      }

      return res.json({ ok: true, sku, ficha_id: fichaId, upserted });
    } catch (err) {
      logger.error({ msg: "fichas.atributos.upsert.error", sku, err });
      return res.status(500).json({ ok: false, reason: "INTERNAL_ERROR" });
    }
  },
);

export default router;

