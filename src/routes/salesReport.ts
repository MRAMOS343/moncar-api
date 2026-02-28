import { Router, Request, Response } from "express";
import ExcelJS from "exceljs";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { logger } from "../logger";

const router = Router();

// GET /api/v1/sales/report
router.get("/sales/report", requireAuth, async (req: Request, res: Response) => {
  try {
    const { from, to, sucursal_id } = req.query as Record<string, string>;

    // ── Validación ──────────────────────────────────────────────────────────
    if (!from) {
      return res.status(400).json({ ok: false, error: "El parámetro 'from' es requerido" });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || (to && !dateRegex.test(to))) {
      return res.status(400).json({ ok: false, error: "Formato de fecha inválido. Usar YYYY-MM-DD" });
    }

    const fromDate = from;
    const toDate   = to ?? new Date().toISOString().split("T")[0]; // default: hoy

    // ── Queries ─────────────────────────────────────────────────────────────
    const params: any[] = [fromDate, toDate];
    let sucursalFilter = "";
    if (sucursal_id) {
      params.push(sucursal_id);
      sucursalFilter = `AND v.sucursal_id = $${params.length}`;
    }

    // Hoja 2: Detalle de ventas
    const ventasRows = await query<{
      folio_numero: string;
      usu_fecha: string;
      usu_hora: string;
      sucursal_id: string;
      estado_origen: string;
      pagos_resumen: string;
      subtotal: number;
      impuesto: number;
      total: number;
      cancelada: boolean;
    }>(
      `SELECT
         v.folio_numero,
         v.usu_fecha,
         v.usu_hora,
         v.sucursal_id,
         v.estado_origen,
         COALESCE(pr.pagos_resumen, '') AS pagos_resumen,
         v.subtotal::numeric            AS subtotal,
         v.impuesto::numeric            AS impuesto,
         v.total::numeric               AS total,
         COALESCE(v.cancelada, false)   AS cancelada
       FROM ventas v
       LEFT JOIN LATERAL (
         SELECT string_agg(
           x.metodo || ':' || trim(to_char(x.monto, 'FM999999990.00')),
           ', ' ORDER BY x.metodo
         ) AS pagos_resumen
         FROM (
           SELECT metodo, SUM(monto) AS monto
           FROM pagos_venta
           WHERE venta_id = v.venta_id
           GROUP BY metodo
         ) x
       ) pr ON true
       WHERE
         v.usu_fecha >= $1
         AND v.usu_fecha <= $2
         ${sucursalFilter}
       ORDER BY v.usu_fecha DESC, v.venta_id DESC`,
      params
    );

    // Hoja 1: Resumen por sucursal
    const resumenSucursal = await query<{
      sucursal_id: string;
      total_ventas: number;
      num_transacciones: number;
    }>(
      `SELECT
         v.sucursal_id,
         SUM(v.total)::numeric  AS total_ventas,
         COUNT(*)               AS num_transacciones
       FROM ventas v
       WHERE
         v.usu_fecha >= $1
         AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY v.sucursal_id
       ORDER BY total_ventas DESC`,
      params
    );

    // Hoja 1: Resumen por método de pago
    const resumenPagos = await query<{
      metodo: string;
      total: number;
      num_pagos: number;
    }>(
      `SELECT
         p.metodo,
         SUM(p.monto)::numeric AS total,
         COUNT(*)              AS num_pagos
       FROM pagos_venta p
       JOIN ventas v ON v.venta_id = p.venta_id
       WHERE
         v.usu_fecha >= $1
         AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY p.metodo
       ORDER BY total DESC`,
      params
    );

    // ── KPIs globales ────────────────────────────────────────────────────────
    const ventasActivas = ventasRows.filter(v => !v.cancelada);
    const totalVentas   = ventasActivas.reduce((acc, v) => acc + Number(v.total), 0);
    const numTx         = ventasActivas.length;
    const ticketProm    = numTx > 0 ? totalVentas / numTx : 0;

    // ── Construir Excel ──────────────────────────────────────────────────────
    const workbook  = new ExcelJS.Workbook();
    workbook.creator    = "Moncar POS";
    workbook.lastModifiedBy = "API";
    workbook.created    = new Date();
    workbook.modified   = new Date();

    // ── Estilos reutilizables ────────────────────────────────────────────────
    const NAVY   = "1A3A5C";
    const WHITE  = "FFFFFF";
    const GRAY   = "F2F3F4";
    const RED    = "FADBD8";
    const GREEN  = "D5F5E3";

    const headerFill = (color = NAVY): ExcelJS.FillPattern => ({
      type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` }
    });
    const cellFill = (color: string): ExcelJS.FillPattern => ({
      type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` }
    });
    const thinBorder: Partial<ExcelJS.Borders> = {
      top:    { style: "thin", color: { argb: "FFCCCCCC" } },
      left:   { style: "thin", color: { argb: "FFCCCCCC" } },
      bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
      right:  { style: "thin", color: { argb: "FFCCCCCC" } },
    };

    // ─────────────────────────────────────────────────────────────────────────
    // HOJA 1 — RESUMEN
    // ─────────────────────────────────────────────────────────────────────────
    const wsResumen = workbook.addWorksheet("Resumen", {
      views: [{ showGridLines: false }]
    });
    wsResumen.columns = [
      { width: 30 }, { width: 22 }, { width: 22 }, { width: 22 }
    ];

    // Título
    wsResumen.mergeCells("A1:D1");
    const titleCell = wsResumen.getCell("A1");
    titleCell.value = "REPORTE DE VENTAS — MONCAR POS";
    titleCell.font  = { bold: true, size: 14, color: { argb: `FF${WHITE}` } };
    titleCell.fill  = headerFill();
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    wsResumen.getRow(1).height = 28;

    // Período
    wsResumen.mergeCells("A2:D2");
    const periodoCell = wsResumen.getCell("A2");
    periodoCell.value = `Período: ${formatDate(fromDate)} — ${formatDate(toDate)}${sucursal_id ? `  |  Sucursal: ${sucursal_id}` : "  |  Todas las sucursales"}`;
    periodoCell.font  = { italic: true, size: 10, color: { argb: "FF566573" } };
    periodoCell.fill  = cellFill("EAF2FF");
    periodoCell.alignment = { horizontal: "center" };

    wsResumen.addRow([]); // separador

    // KPIs
    addSectionHeader(wsResumen, "A4", "D4", "📊  INDICADORES GENERALES");
    addKpiRow(wsResumen, 5, "Total de Ventas",       formatMXN(totalVentas), GRAY);
    addKpiRow(wsResumen, 6, "Número de Transacciones", numTx.toString(),      WHITE);
    addKpiRow(wsResumen, 7, "Ticket Promedio",         formatMXN(ticketProm), GRAY);
    addKpiRow(wsResumen, 8, "Ventas Canceladas",
      ventasRows.filter(v => v.cancelada).length.toString(), WHITE);

    wsResumen.addRow([]);

    // Por sucursal
    addSectionHeader(wsResumen, "A10", "D10", "🏪  DESGLOSE POR SUCURSAL");
    addTableHeader(wsResumen, 11, ["Sucursal", "Total Ventas", "Transacciones", "Ticket Prom."]);
    resumenSucursal.forEach((row, i) => {
      const r = wsResumen.addRow([
        row.sucursal_id,
        { formula: "", result: Number(row.total_ventas) },
        Number(row.num_transacciones),
        { formula: "", result: Number(row.total_ventas) / Number(row.num_transacciones) },
      ]);
      r.getCell(2).numFmt = '"$"#,##0.00';
      r.getCell(4).numFmt = '"$"#,##0.00';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 4);
    });

    wsResumen.addRow([]);

    // Por método de pago
    const nextRow = wsResumen.lastRow!.number + 1;
    addSectionHeader(wsResumen, `A${nextRow}`, `D${nextRow}`, "💳  DESGLOSE POR MÉTODO DE PAGO");
    addTableHeader(wsResumen, nextRow + 1, ["Método", "Total", "Num. Pagos", ""]);
    resumenPagos.forEach((row, i) => {
      const r = wsResumen.addRow([row.metodo, Number(row.total), Number(row.num_pagos), ""]);
      r.getCell(2).numFmt = '"$"#,##0.00';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 3);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // HOJA 2 — DETALLE
    // ─────────────────────────────────────────────────────────────────────────
    const wsDetalle = workbook.addWorksheet("Detalle", {
      views: [{ showGridLines: false }]
    });

    wsDetalle.columns = [
      { header: "Folio",     key: "folio",    width: 14 },
      { header: "Fecha",     key: "fecha",    width: 14 },
      { header: "Hora",      key: "hora",     width: 10 },
      { header: "Sucursal",  key: "sucursal", width: 14 },
      { header: "Estado",    key: "estado",   width: 14 },
      { header: "Pagos",     key: "pagos",    width: 24 },
      { header: "Subtotal",  key: "subtotal", width: 14 },
      { header: "IVA",       key: "iva",      width: 14 },
      { header: "Total",     key: "total",    width: 14 },
      { header: "Cancelada", key: "cancelada",width: 12 },
    ];

    // Estilizar encabezados
    const headerRow = wsDetalle.getRow(1);
    headerRow.eachCell(cell => {
      cell.fill   = headerFill();
      cell.font   = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = thinBorder;
    });
    headerRow.height = 22;

    // Filas de datos
    ventasRows.forEach((v, i) => {
      const estadoLabel =
        v.estado_origen === "CO" ? "Completada" :
        v.estado_origen === "CA" ? "Cancelada"  : (v.estado_origen ?? "");

      const row = wsDetalle.addRow({
        folio:    v.folio_numero ?? "",
        fecha:    formatDate(v.usu_fecha),
        hora:     v.usu_hora ? v.usu_hora.substring(0, 5) : "",
        sucursal: v.sucursal_id ?? "",
        estado:   estadoLabel,
        pagos:    v.pagos_resumen ?? "",
        subtotal: Number(v.subtotal),
        iva:      Number(v.impuesto),
        total:    Number(v.total),
        cancelada: v.cancelada ? "Sí" : "No",
      });

      // Formato moneda
      ["subtotal", "iva", "total"].forEach(key => {
        row.getCell(key).numFmt = '"$"#,##0.00';
      });

      // Color por estado
      const bgColor = v.cancelada ? RED : i % 2 === 0 ? GRAY : WHITE;
      row.eachCell(cell => {
        cell.fill   = cellFill(bgColor);
        cell.border = thinBorder;
        cell.alignment = { vertical: "middle" };
      });
      row.getCell("total").font = { bold: true };
    });

    // Fila de totales
    const lastDataRow = wsDetalle.lastRow!.number;
    const totalesRow  = wsDetalle.addRow({
      folio:    "TOTAL",
      subtotal: { formula: `SUM(G2:G${lastDataRow})` },
      iva:      { formula: `SUM(H2:H${lastDataRow})` },
      total:    { formula: `SUM(I2:I${lastDataRow})` },
    });
    totalesRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: `FF${WHITE}` } };
      cell.fill = headerFill();
      cell.border = thinBorder;
    });
    ["subtotal","iva","total"].forEach(key => {
      totalesRow.getCell(key).numFmt = '"$"#,##0.00';
    });

    // Autofilter en detalle
    wsDetalle.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: 10 },
    };

    // ── Enviar response ──────────────────────────────────────────────────────
    const filename = `reporte_ventas_${toDate}.xlsx`;

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    await workbook.xlsx.write(res);
    res.end();

    logger.info({ from: fromDate, to: toDate, sucursal_id, rows: ventasRows.length },
      "sales.report.generated");

  } catch (err) {
    logger.error({ err }, "sales.report.error");
    // Solo enviar JSON si no empezamos a escribir el Excel
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Error generando el reporte" });
    }
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + (dateStr.length === 10 ? "T12:00:00" : ""));
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatMXN(n: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
}

function addSectionHeader(ws: ExcelJS.Worksheet, from: string, to: string, label: string) {
  ws.mergeCells(`${from}:${to}`);
  const cell = ws.getCell(from);
  cell.value = label;
  cell.font  = { bold: true, size: 11, color: { argb: "FF1A3A5C" } };
  cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6E4F0" } };
  cell.alignment = { horizontal: "left", indent: 1 };
}

function addTableHeader(ws: ExcelJS.Worksheet, rowNum: number, labels: string[]) {
  const row = ws.getRow(rowNum);
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = label;
    cell.font  = { bold: true, size: 10, color: { argb: "FF2C3E50" } };
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFAEB6BF" } };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FF1A3A5C" } }
    };
  });
}

function addKpiRow(ws: ExcelJS.Worksheet, rowNum: number, label: string, value: string, bg: string) {
  const row = ws.getRow(rowNum);
  row.getCell(1).value = label;
  row.getCell(2).value = value;
  row.getCell(1).font = { size: 10, color: { argb: "FF566573" } };
  row.getCell(2).font = { bold: true, size: 11, color: { argb: "FF1A3A5C" } };
  for (let i = 1; i <= 4; i++) {
    row.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${bg}` } };
  }
}

function applyBorders(row: ExcelJS.Row, cols: number) {
  for (let i = 1; i <= cols; i++) {
    row.getCell(i).border = {
      top:    { style: "thin", color: { argb: "FFDDDDDD" } },
      bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
      left:   { style: "thin", color: { argb: "FFDDDDDD" } },
      right:  { style: "thin", color: { argb: "FFDDDDDD" } },
    };
  }
}

export default router;
