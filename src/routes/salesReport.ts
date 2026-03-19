import { Router, Request, Response } from "express";
import ExcelJS from "exceljs";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { logger } from "../logger";

const router = Router();

// ── Colores reutilizables ────────────────────────────────────────────────────
const NAVY  = "1A3A5C";
const WHITE = "FFFFFF";
const GRAY  = "F2F3F4";
const RED_BG   = "FADBD8";
const GREEN_BG = "D5F5E3";
const LIGHT_BLUE = "EAF2FF";
const SECTION_BG = "D6E4F0";
const HEADER_BG  = "AEB6BF";

// ── Helpers de estilo ────────────────────────────────────────────────────────

function headerFill(color = NAVY): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
}
function cellFill(color: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
}
const thinBorder: Partial<ExcelJS.Borders> = {
  top:    { style: "thin", color: { argb: "FFCCCCCC" } },
  left:   { style: "thin", color: { argb: "FFCCCCCC" } },
  bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
  right:  { style: "thin", color: { argb: "FFCCCCCC" } },
};

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + (dateStr.length === 10 ? "T12:00:00" : ""));
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function formatMXN(n: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
}

function getLastDayOfMonth(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay.toISOString().split("T")[0];
}

function addSectionHeader(ws: ExcelJS.Worksheet, from: string, to: string, label: string) {
  ws.mergeCells(`${from}:${to}`);
  const cell = ws.getCell(from);
  cell.value = label;
  cell.font  = { bold: true, size: 11, color: { argb: `FF${NAVY}` } };
  cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${SECTION_BG}` } };
  cell.alignment = { horizontal: "left", indent: 1 };
}

function addTableHeaders(ws: ExcelJS.Worksheet, rowNum: number, labels: string[]) {
  const row = ws.getRow(rowNum);
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = label;
    cell.font  = { bold: true, size: 10, color: { argb: "FF2C3E50" } };
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_BG}` } };
    cell.border = { bottom: { style: "medium", color: { argb: `FF${NAVY}` } } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  row.height = 20;
}

function addKpiRow(ws: ExcelJS.Worksheet, rowNum: number, label: string, value: string, bg: string, extraCols = 4) {
  const row = ws.getRow(rowNum);
  row.getCell(1).value = label;
  row.getCell(2).value = value;
  row.getCell(1).font = { size: 10, color: { argb: "FF566573" } };
  row.getCell(2).font = { bold: true, size: 11, color: { argb: `FF${NAVY}` } };
  for (let i = 1; i <= extraCols; i++) {
    row.getCell(i).fill = cellFill(bg);
  }
}

function applyBorders(row: ExcelJS.Row, cols: number) {
  for (let i = 1; i <= cols; i++) {
    row.getCell(i).border = thinBorder;
  }
}

function addEmptyMessage(ws: ExcelJS.Worksheet, startRow: number, cols: number, msg: string) {
  ws.mergeCells(startRow, 1, startRow, cols);
  const c = ws.getCell(startRow, 1);
  c.value = msg;
  c.font = { italic: true, size: 10, color: { argb: "FF999999" } };
  c.alignment = { horizontal: "center", vertical: "middle" };
}

// GET /api/v1/sales/report
router.get("/sales/report", requireAuth, async (req: Request, res: Response) => {
  try {
    const { from, to, month, sucursal_id } = req.query as Record<string, string>;

    // ── Validación ───────────────────────────────────────────────────────
    if (month && (from || to)) {
      return res.status(400).json({
        ok: false,
        error: "Usa 'month' o el rango 'from/to', no ambos al mismo tiempo",
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

    if (!month && !from) {
      return res.status(400).json({
        ok: false,
        error: "Debes enviar 'month' (YYYY-MM) o 'from' (YYYY-MM-DD)",
      });
    }

    if (month && !monthRegex.test(month)) {
      return res.status(400).json({ ok: false, error: "Formato de mes inválido. Usar YYYY-MM" });
    }

    if (from && (!dateRegex.test(from) || (to && !dateRegex.test(to)))) {
      return res.status(400).json({ ok: false, error: "Formato de fecha inválido. Usar YYYY-MM-DD" });
    }

    const today = new Date().toISOString().split("T")[0];
    const currentMonth = today.slice(0, 7);

    let fromDate: string;
    let toDate: string;

    if (month) {
      const [yearStr, monthStr] = month.split("-");
      const year = Number(yearStr);
      const monthNum = Number(monthStr);

      if (month > currentMonth) {
        return res.status(400).json({ ok: false, error: "No se puede generar reporte para meses futuros" });
      }

      fromDate = `${month}-01`;
      toDate = month === currentMonth ? today : getLastDayOfMonth(year, monthNum);
    } else {
      fromDate = from!;
      toDate = to ?? today;
    }

    // ── Calcular período anterior ────────────────────────────────────────
    const d1 = new Date(fromDate + "T00:00:00");
    const d2 = new Date(toDate + "T23:59:59");
    const durationMs  = d2.getTime() - d1.getTime();
    const durationDays = Math.round(durationMs / 86400000) + 1;
    const prevEnd   = new Date(d1.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (durationDays - 1) * 86400000);
    const prevFromDate = prevStart.toISOString().split("T")[0];
    const prevToDate   = prevEnd.toISOString().split("T")[0];

    // ── Params base ──────────────────────────────────────────────────────
    const params: any[] = [fromDate, toDate];
    let sucursalFilter = "";
    if (sucursal_id) {
      params.push(sucursal_id);
      sucursalFilter = `AND v.sucursal_id = $${params.length}`;
    }

    const prevParams: any[] = [prevFromDate, prevToDate];
    let prevSucursalFilter = "";
    if (sucursal_id) {
      prevParams.push(sucursal_id);
      prevSucursalFilter = `AND v.sucursal_id = $${prevParams.length}`;
    }

    // ══════════════════════════════════════════════════════════════════════
    // QUERIES
    // ══════════════════════════════════════════════════════════════════════

    // Q1: Detalle de ventas
    const ventasRows = await query<{
      venta_id: number; folio_numero: string; usu_fecha: string; usu_hora: string;
      sucursal_id: string; estado_origen: string; pagos_metodo_resumen: string; pagos_total_resumen: string;
      subtotal: number; impuesto: number; total: number; cancelada: boolean;
    }>(
      `SELECT
         v.venta_id, v.folio_numero, v.usu_fecha, v.usu_hora, v.sucursal_id, v.estado_origen,
         COALESCE(pr.pagos_metodo_resumen, '') AS pagos_metodo_resumen,
         COALESCE(pr.pagos_total_resumen, '') AS pagos_total_resumen,
         v.subtotal::numeric AS subtotal, v.impuesto::numeric AS impuesto,
         v.total::numeric AS total, COALESCE(v.cancelada, false) AS cancelada
       FROM ventas v
       LEFT JOIN LATERAL (
         SELECT
           string_agg(x.metodo, ', ' ORDER BY x.metodo) AS pagos_metodo_resumen,
           string_agg(trim(to_char(x.monto, 'FM999999990.00')), ', ' ORDER BY x.metodo) AS pagos_total_resumen
         FROM (SELECT metodo, SUM(monto) AS monto FROM pagos_venta WHERE venta_id = v.venta_id GROUP BY metodo) x
       ) pr ON true
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2 ${sucursalFilter}
       ORDER BY v.usu_fecha DESC, v.venta_id DESC`,
      params
    );

    // Q2: KPIs período anterior
    const prevKpis = await query<{
      total_ventas: number; num_transacciones: number;
    }>(
      `SELECT
         COALESCE(SUM(v.total), 0)::numeric AS total_ventas,
         COUNT(*) AS num_transacciones
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${prevSucursalFilter}`,
      prevParams
    );

    // Q3: Top/Bottom días de venta
    const ventasPorDia = await query<{
      dia: string; total_dia: number; num_tx: number;
    }>(
      `SELECT
         v.usu_fecha AS dia,
         SUM(v.total)::numeric AS total_dia,
         COUNT(*) AS num_tx
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY v.usu_fecha
       ORDER BY v.usu_fecha ASC`,
      params
    );

    // Q4: Hora pico
    const ventasPorHora = await query<{
      hora: number; total_hora: number; num_tx: number;
    }>(
      `SELECT
         EXTRACT(HOUR FROM v.usu_hora::time)::int AS hora,
         SUM(v.total)::numeric AS total_hora,
         COUNT(*) AS num_tx
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         AND v.usu_hora IS NOT NULL
         ${sucursalFilter}
       GROUP BY hora
       ORDER BY hora ASC`,
      params
    );

    // Q5: Tendencia diaria por sucursal
    const tendenciaDiariaSucursal = await query<{
      dia: string; sucursal_id: string; total_dia: number;
    }>(
      `SELECT
         v.usu_fecha AS dia, v.sucursal_id,
         SUM(v.total)::numeric AS total_dia
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY v.usu_fecha, v.sucursal_id
       ORDER BY v.usu_fecha ASC, v.sucursal_id ASC`,
      params
    );

    // Q6: Ventas por producto
    const productoVentas = await query<{
      articulo: string; descrip: string; marca: string;
      cantidad_vendida: number; ingresos: number; costo_u: number;
    }>(
      `SELECT
         lv.articulo,
         COALESCE(p.descrip, lv.articulo) AS descrip,
         COALESCE(p.marca, '') AS marca,
         SUM(lv.cantidad)::numeric AS cantidad_vendida,
         SUM(lv.importe_linea)::numeric AS ingresos,
         COALESCE(p.costo_u, 0)::numeric AS costo_u
       FROM lineas_venta lv
       JOIN ventas v ON v.venta_id = lv.venta_id
       LEFT JOIN productos p ON p.sku = lv.articulo
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY lv.articulo, p.descrip, p.marca, p.costo_u
       ORDER BY ingresos DESC`,
      params
    );

    // Q7: Productos sin movimiento (con existencia > 0)
    const sinMovimiento = await query<{
      sku: string; descrip: string; marca: string; existencia_total: number;
    }>(
      `SELECT
         p.sku, p.descrip,
         COALESCE(p.marca, '') AS marca,
         COALESCE(inv.existencia_total, 0)::numeric AS existencia_total
       FROM productos p
       LEFT JOIN (
         SELECT sku, SUM(existencia) AS existencia_total FROM inventario GROUP BY sku
       ) inv ON inv.sku = p.sku
       WHERE NOT EXISTS (
         SELECT 1 FROM lineas_venta lv
         JOIN ventas v ON v.venta_id = lv.venta_id
         WHERE lv.articulo = p.sku
           AND v.usu_fecha >= $1 AND v.usu_fecha <= $2
           AND COALESCE(v.cancelada, false) = false
           ${sucursalFilter}
       )
       AND COALESCE(inv.existencia_total, 0) > 0
       ORDER BY inv.existencia_total DESC
       LIMIT 50`,
      params
    );

    // Q8: Resumen por sucursal
    const resumenSucursal = await query<{
      sucursal_id: string; total_ventas: number; num_transacciones: number;
    }>(
      `SELECT
         v.sucursal_id,
         SUM(v.total)::numeric AS total_ventas,
         COUNT(*) AS num_transacciones
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY v.sucursal_id
       ORDER BY total_ventas DESC`,
      params
    );

    // Q9: Tendencia semanal por sucursal
    const tendenciaSemanalSucursal = await query<{
      semana: string; sucursal_id: string; total_semana: number;
    }>(
      `SELECT
         to_char(date_trunc('week', v.usu_fecha::date), 'YYYY-MM-DD') AS semana,
         v.sucursal_id,
         SUM(v.total)::numeric AS total_semana
       FROM ventas v
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY semana, v.sucursal_id
       ORDER BY semana ASC, v.sucursal_id ASC`,
      params
    );

    // Q10: Resumen por método de pago
    const resumenPagos = await query<{
      metodo: string; total: number; num_pagos: number;
    }>(
      `SELECT
         p.metodo, SUM(p.monto)::numeric AS total, COUNT(*) AS num_pagos
       FROM pagos_venta p
       JOIN ventas v ON v.venta_id = p.venta_id
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY p.metodo
       ORDER BY total DESC`,
      params
    );

    // Q11: Tendencia semanal por método de pago
    const tendenciaSemanalPagos = await query<{
      semana: string; metodo: string; total_semana: number;
    }>(
      `SELECT
         to_char(date_trunc('week', v.usu_fecha::date), 'YYYY-MM-DD') AS semana,
         p.metodo,
         SUM(p.monto)::numeric AS total_semana
       FROM pagos_venta p
       JOIN ventas v ON v.venta_id = p.venta_id
       WHERE v.usu_fecha >= $1 AND v.usu_fecha <= $2
         AND COALESCE(v.cancelada, false) = false
         ${sucursalFilter}
       GROUP BY semana, p.metodo
       ORDER BY semana ASC, p.metodo ASC`,
      params
    );

    // ══════════════════════════════════════════════════════════════════════
    // CÁLCULOS
    // ══════════════════════════════════════════════════════════════════════

    const ventasActivas  = ventasRows.filter(v => !v.cancelada);
    const totalVentas    = ventasActivas.reduce((a, v) => a + Number(v.total), 0);
    const numTx          = ventasActivas.length;
    const ticketProm     = numTx > 0 ? totalVentas / numTx : 0;
    const numCanceladas  = ventasRows.filter(v => v.cancelada).length;
    const pctCanceladas  = ventasRows.length > 0 ? (numCanceladas / ventasRows.length) * 100 : 0;

    const prevTotal  = Number(prevKpis[0]?.total_ventas ?? 0);
    const prevNumTx  = Number(prevKpis[0]?.num_transacciones ?? 0);
    const prevTicket = prevNumTx > 0 ? prevTotal / prevNumTx : 0;
    const diffVentas = totalVentas - prevTotal;
    const pctChange  = prevTotal > 0 ? ((totalVentas - prevTotal) / prevTotal) * 100 : (totalVentas > 0 ? 100 : 0);

    const diasOrdenados = [...ventasPorDia].sort((a, b) => Number(b.total_dia) - Number(a.total_dia));
    const top3Dias    = diasOrdenados.slice(0, 3);
    const bottom3Dias = diasOrdenados.length > 3 ? diasOrdenados.slice(-3).reverse() : [];

    const horaPico = ventasPorHora.length > 0
      ? ventasPorHora.reduce((a, b) => Number(b.total_hora) > Number(a.total_hora) ? b : a)
      : null;

    const totalIngresosProductos = productoVentas.reduce((a, p) => a + Number(p.ingresos), 0);
    const totalVentasSucursales  = resumenSucursal.reduce((a, s) => a + Number(s.total_ventas), 0);
    const totalPagos = resumenPagos.reduce((a, p) => a + Number(p.total), 0);

    // ══════════════════════════════════════════════════════════════════════
    // CONSTRUIR EXCEL
    // ══════════════════════════════════════════════════════════════════════

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Moncar POS";
    workbook.lastModifiedBy = "API";
    workbook.created  = new Date();
    workbook.modified = new Date();

    // ─────────────────────────────────────────────────────────────────────
    // HOJA 1 — RESUMEN EJECUTIVO
    // ─────────────────────────────────────────────────────────────────────
    const ws1 = workbook.addWorksheet("Resumen", { views: [{ showGridLines: false }] });
    ws1.columns = [{ width: 32 }, { width: 24 }, { width: 24 }, { width: 24 }, { width: 24 }];

    ws1.mergeCells("A1:E1");
    const t1 = ws1.getCell("A1");
    t1.value = "REPORTE DE VENTAS — MONCAR POS";
    t1.font = { bold: true, size: 14, color: { argb: `FF${WHITE}` } };
    t1.fill = headerFill();
    t1.alignment = { horizontal: "center", vertical: "middle" };
    ws1.getRow(1).height = 28;

    ws1.mergeCells("A2:E2");
    const pc = ws1.getCell("A2");
    pc.value = `Período: ${formatDate(fromDate)} — ${formatDate(toDate)}${sucursal_id ? `  |  Sucursal: ${sucursal_id}` : "  |  Todas las sucursales"}  |  ${durationDays} días`;
    pc.font = { italic: true, size: 10, color: { argb: "FF566573" } };
    pc.fill = cellFill(LIGHT_BLUE);
    pc.alignment = { horizontal: "center" };

    let row = 4;

    // KPIs Generales
    addSectionHeader(ws1, `A${row}`, `E${row}`, "INDICADORES GENERALES");
    row++;
    addKpiRow(ws1, row++, "Total de Ventas",          formatMXN(totalVentas), GRAY, 5);
    addKpiRow(ws1, row++, "Número de Transacciones",   numTx.toString(), WHITE, 5);
    addKpiRow(ws1, row++, "Ticket Promedio",            formatMXN(ticketProm), GRAY, 5);
    addKpiRow(ws1, row++, "Ventas Canceladas",          `${numCanceladas} (${pctCanceladas.toFixed(1)}%)`, WHITE, 5);
    row++;

    // Comparación vs Período Anterior
    addSectionHeader(ws1, `A${row}`, `E${row}`, "COMPARACIÓN vs PERÍODO ANTERIOR");
    row++;
    addTableHeaders(ws1, row, ["Métrica", "Período Actual", "Período Anterior", "Diferencia $", "Cambio %"]);
    row++;

    const rVentas = ws1.getRow(row);
    rVentas.values = ["Total Ventas", totalVentas, prevTotal, diffVentas, pctChange / 100];
    [2, 3, 4].forEach(c => { rVentas.getCell(c).numFmt = '"$"#,##0.00'; });
    rVentas.getCell(5).numFmt = '0.0%;-0.0%';
    rVentas.getCell(5).font = { bold: true, color: { argb: pctChange >= 0 ? "FF27AE60" : "FFE74C3C" } };
    rVentas.eachCell(c => { c.fill = cellFill(GRAY); });
    applyBorders(rVentas, 5);
    row++;

    const diffTx = numTx - prevNumTx;
    const pctTx  = prevNumTx > 0 ? ((numTx - prevNumTx) / prevNumTx) * 100 : (numTx > 0 ? 100 : 0);
    const rTx = ws1.getRow(row);
    rTx.values = ["Transacciones", numTx, prevNumTx, diffTx, pctTx / 100];
    rTx.getCell(5).numFmt = '0.0%;-0.0%';
    rTx.getCell(5).font = { bold: true, color: { argb: pctTx >= 0 ? "FF27AE60" : "FFE74C3C" } };
    applyBorders(rTx, 5);
    row++;

    const diffTicket = ticketProm - prevTicket;
    const pctTicket  = prevTicket > 0 ? ((ticketProm - prevTicket) / prevTicket) * 100 : (ticketProm > 0 ? 100 : 0);
    const rTicket = ws1.getRow(row);
    rTicket.values = ["Ticket Promedio", ticketProm, prevTicket, diffTicket, pctTicket / 100];
    [2, 3, 4].forEach(c => { rTicket.getCell(c).numFmt = '"$"#,##0.00'; });
    rTicket.getCell(5).numFmt = '0.0%;-0.0%';
    rTicket.getCell(5).font = { bold: true, color: { argb: pctTicket >= 0 ? "FF27AE60" : "FFE74C3C" } };
    rTicket.eachCell(c => { c.fill = cellFill(GRAY); });
    applyBorders(rTicket, 5);
    row++;

    const noteRow = ws1.getRow(row);
    ws1.mergeCells(row, 1, row, 5);
    noteRow.getCell(1).value = `Período anterior: ${formatDate(prevFromDate)} — ${formatDate(prevToDate)}`;
    noteRow.getCell(1).font = { italic: true, size: 9, color: { argb: "FF999999" } };
    row += 2;

    // Top 3 / Bottom 3 Días
    addSectionHeader(ws1, `A${row}`, `E${row}`, "TOP 3 MEJORES DÍAS / PEORES DÍAS");
    row++;

    if (top3Dias.length > 0) {
      addTableHeaders(ws1, row, ["", "Fecha", "Total Día", "Transacciones", ""]);
      row++;
      top3Dias.forEach((d, i) => {
        const r = ws1.getRow(row);
        r.values = [`Mejor #${i + 1}`, formatDate(d.dia), Number(d.total_dia), Number(d.num_tx), ""];
        r.getCell(3).numFmt = '"$"#,##0.00';
        r.eachCell(c => { c.fill = cellFill(GREEN_BG); });
        applyBorders(r, 4);
        row++;
      });
      row++;
      bottom3Dias.forEach((d, i) => {
        const r = ws1.getRow(row);
        r.values = [`Peor #${bottom3Dias.length - i}`, formatDate(d.dia), Number(d.total_dia), Number(d.num_tx), ""];
        r.getCell(3).numFmt = '"$"#,##0.00';
        r.eachCell(c => { c.fill = cellFill(RED_BG); });
        applyBorders(r, 4);
        row++;
      });
    } else {
      addEmptyMessage(ws1, row, 5, "Sin datos de ventas diarias para el período");
      row++;
    }
    row++;

    // Hora Pico
    addSectionHeader(ws1, `A${row}`, `E${row}`, "HORA PICO DE VENTAS");
    row++;
    if (horaPico) {
      addKpiRow(ws1, row, "Hora con más ventas",
        `${String(horaPico.hora).padStart(2, "0")}:00 - ${String(horaPico.hora + 1).padStart(2, "0")}:00`, GRAY, 5);
      row++;
      addKpiRow(ws1, row, "Total en esa hora", formatMXN(Number(horaPico.total_hora)), WHITE, 5);
      row++;
      addKpiRow(ws1, row, "Transacciones en esa hora", String(horaPico.num_tx), GRAY, 5);
      row++;
    } else {
      addEmptyMessage(ws1, row, 5, "Sin datos de hora");
      row++;
    }
    row++;

    // Distribución por hora
    addSectionHeader(ws1, `A${row}`, `E${row}`, "VENTAS POR HORA DEL DÍA  (seleccionar para gráfica)");
    row++;
    addTableHeaders(ws1, row, ["Hora", "Total Ventas", "Transacciones", "", ""]);
    row++;
    ventasPorHora.forEach((h, i) => {
      const r = ws1.getRow(row);
      r.values = [`${String(h.hora).padStart(2, "0")}:00`, Number(h.total_hora), Number(h.num_tx), "", ""];
      r.getCell(2).numFmt = '"$"#,##0.00';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 3);
      row++;
    });
    row++;

    // Tendencia Diaria
    addSectionHeader(ws1, `A${row}`, `E${row}`, "TENDENCIA DIARIA DE VENTAS  (seleccionar para gráfica de línea)");
    row++;

    const sucursalesUnicas = [...new Set(tendenciaDiariaSucursal.map(t => t.sucursal_id))].sort();
    const diasUnicos = [...new Set(tendenciaDiariaSucursal.map(t => t.dia))].sort();

    if (sucursalesUnicas.length <= 1) {
      addTableHeaders(ws1, row, ["Fecha", "Total Día", "", "", ""]);
      row++;
      ventasPorDia.forEach((d, i) => {
        const r = ws1.getRow(row);
        r.values = [formatDate(d.dia), Number(d.total_dia), "", "", ""];
        r.getCell(2).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, 2);
        row++;
      });
    } else {
      const headers = ["Fecha", ...sucursalesUnicas];
      addTableHeaders(ws1, row, headers.length <= 5 ? [...headers, ...Array(5 - headers.length).fill("")] : headers.slice(0, 5));
      // If more than 4 sucursales, add extra header cells
      if (headers.length > 5) {
        const extraRow = ws1.getRow(row);
        for (let c = 6; c <= headers.length; c++) {
          const cell = extraRow.getCell(c);
          cell.value = headers[c - 1];
          cell.font = { bold: true, size: 10, color: { argb: "FF2C3E50" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_BG}` } };
        }
      }
      row++;
      const lookup = new Map<string, Map<string, number>>();
      tendenciaDiariaSucursal.forEach(t => {
        if (!lookup.has(t.dia)) lookup.set(t.dia, new Map());
        lookup.get(t.dia)!.set(t.sucursal_id, Number(t.total_dia));
      });
      diasUnicos.forEach((dia, i) => {
        const vals: any[] = [formatDate(dia)];
        sucursalesUnicas.forEach(s => vals.push(lookup.get(dia)?.get(s) ?? 0));
        const r = ws1.getRow(row);
        r.values = vals;
        for (let c = 2; c <= vals.length; c++) r.getCell(c).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, vals.length);
        row++;
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // HOJA 2 — POR PRODUCTO
    // ─────────────────────────────────────────────────────────────────────
    const ws2 = workbook.addWorksheet("Por Producto", { views: [{ showGridLines: false }] });
    ws2.columns = [
      { width: 18 }, { width: 36 }, { width: 16 }, { width: 14 },
      { width: 18 }, { width: 14 }, { width: 16 }, { width: 16 },
    ];

    ws2.mergeCells("A1:H1");
    const t2 = ws2.getCell("A1");
    t2.value = "VENTAS POR PRODUCTO — MONCAR POS";
    t2.font = { bold: true, size: 14, color: { argb: `FF${WHITE}` } };
    t2.fill = headerFill();
    t2.alignment = { horizontal: "center", vertical: "middle" };
    ws2.getRow(1).height = 28;

    ws2.mergeCells("A2:H2");
    const pc2 = ws2.getCell("A2");
    pc2.value = `Período: ${formatDate(fromDate)} — ${formatDate(toDate)}`;
    pc2.font = { italic: true, size: 10, color: { argb: "FF566573" } };
    pc2.fill = cellFill(LIGHT_BLUE);
    pc2.alignment = { horizontal: "center" };

    let r2 = 4;

    addSectionHeader(ws2, `A${r2}`, `H${r2}`, "TOP 20 PRODUCTOS POR INGRESO");
    r2++;
    const topHdrRow = r2;
    addTableHeaders(ws2, r2, ["SKU", "Producto", "Marca", "Cantidad", "Ingresos", "% Total", "Costo Unit.", "Margen Est."]);
    r2++;

    const top20 = productoVentas.slice(0, 20);
    if (top20.length > 0) {
      top20.forEach((p, i) => {
        const ingresos = Number(p.ingresos);
        const costoU   = Number(p.costo_u);
        const cantVend = Number(p.cantidad_vendida);
        const pctTotal = totalIngresosProductos > 0 ? ingresos / totalIngresosProductos : 0;
        const margen   = costoU > 0 ? ingresos - (costoU * cantVend) : null;

        const r = ws2.getRow(r2);
        r.values = [
          p.articulo, p.descrip, p.marca, cantVend,
          ingresos, pctTotal, costoU > 0 ? costoU : "N/D",
          margen !== null ? margen : "N/D",
        ];
        r.getCell(5).numFmt = '"$"#,##0.00';
        r.getCell(6).numFmt = '0.0%';
        if (typeof r.getCell(7).value === "number") r.getCell(7).numFmt = '"$"#,##0.00';
        if (typeof r.getCell(8).value === "number") {
          r.getCell(8).numFmt = '"$"#,##0.00';
          r.getCell(8).font = { color: { argb: (margen ?? 0) >= 0 ? "FF27AE60" : "FFE74C3C" } };
        }
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, 8);
        r2++;
      });
    } else {
      addEmptyMessage(ws2, r2, 8, "Sin datos de ventas por producto en el período");
      r2++;
    }
    r2++;

    // Top 10 datos para gráfica
    addSectionHeader(ws2, `A${r2}`, `H${r2}`, "TOP 10 POR INGRESO  (seleccionar para gráfica de barras)");
    r2++;
    addTableHeaders(ws2, r2, ["Producto", "Ingresos", "", "", "", "", "", ""]);
    r2++;
    productoVentas.slice(0, 10).forEach((p, i) => {
      const r = ws2.getRow(r2);
      r.values = [p.descrip.substring(0, 40), Number(p.ingresos), "", "", "", "", "", ""];
      r.getCell(2).numFmt = '"$"#,##0.00';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 2);
      r2++;
    });
    r2++;

    // Productos sin movimiento
    addSectionHeader(ws2, `A${r2}`, `H${r2}`, "PRODUCTOS SIN MOVIMIENTO EN EL PERÍODO  (con existencia > 0)");
    r2++;

    if (sinMovimiento.length > 0) {
      addTableHeaders(ws2, r2, ["SKU", "Producto", "Marca", "Existencia", "", "", "", ""]);
      r2++;
      sinMovimiento.forEach((p, i) => {
        const r = ws2.getRow(r2);
        r.values = [p.sku, p.descrip, p.marca, Number(p.existencia_total), "", "", "", ""];
        r.getCell(4).numFmt = '#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, 4);
        r2++;
      });
    } else {
      addEmptyMessage(ws2, r2, 8, "Todos los productos con existencia tuvieron movimiento en el período");
      r2++;
    }

    ws2.autoFilter = { from: { row: topHdrRow, column: 1 }, to: { row: topHdrRow, column: 8 } };

    // ─────────────────────────────────────────────────────────────────────
    // HOJA 3 — POR SUCURSAL
    // ─────────────────────────────────────────────────────────────────────
    const ws3 = workbook.addWorksheet("Por Sucursal", { views: [{ showGridLines: false }] });
    const numSucursales = resumenSucursal.length;
    ws3.columns = [{ width: 22 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 16 }];

    ws3.mergeCells("A1:E1");
    const t3 = ws3.getCell("A1");
    t3.value = "ANÁLISIS POR SUCURSAL — MONCAR POS";
    t3.font = { bold: true, size: 14, color: { argb: `FF${WHITE}` } };
    t3.fill = headerFill();
    t3.alignment = { horizontal: "center", vertical: "middle" };
    ws3.getRow(1).height = 28;

    ws3.mergeCells("A2:E2");
    const pc3 = ws3.getCell("A2");
    pc3.value = `Período: ${formatDate(fromDate)} — ${formatDate(toDate)}`;
    pc3.font = { italic: true, size: 10, color: { argb: "FF566573" } };
    pc3.fill = cellFill(LIGHT_BLUE);
    pc3.alignment = { horizontal: "center" };

    let r3 = 4;

    if (numSucursales <= 1) {
      addEmptyMessage(ws3, r3, 5, numSucursales === 1
        ? `Solo hay una sucursal (${resumenSucursal[0].sucursal_id}). Esta hoja es más relevante con múltiples sucursales.`
        : "Sin datos de sucursales en el período.");
      r3 += 2;
    }

    // Tabla comparativa (mostrar incluso con 1 sucursal)
    addSectionHeader(ws3, `A${r3}`, `E${r3}`, "COMPARATIVA DE SUCURSALES");
    r3++;
    addTableHeaders(ws3, r3, ["Sucursal", "Total Ventas", "Transacciones", "Ticket Prom.", "% Participación"]);
    r3++;

    resumenSucursal.forEach((s, i) => {
      const tv = Number(s.total_ventas);
      const nt = Number(s.num_transacciones);
      const tp = nt > 0 ? tv / nt : 0;
      const pct = totalVentasSucursales > 0 ? tv / totalVentasSucursales : 0;

      const r = ws3.getRow(r3);
      r.values = [s.sucursal_id, tv, nt, tp, pct];
      r.getCell(2).numFmt = '"$"#,##0.00';
      r.getCell(4).numFmt = '"$"#,##0.00';
      r.getCell(5).numFmt = '0.0%';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 5);
      r3++;
    });

    if (resumenSucursal.length > 0) {
      const totalRow3 = ws3.getRow(r3);
      totalRow3.values = ["TOTAL", totalVentasSucursales, numTx, ticketProm, 1];
      totalRow3.eachCell(c => {
        c.font = { bold: true, color: { argb: `FF${WHITE}` } };
        c.fill = headerFill();
        c.border = thinBorder;
      });
      totalRow3.getCell(2).numFmt = '"$"#,##0.00';
      totalRow3.getCell(4).numFmt = '"$"#,##0.00';
      totalRow3.getCell(5).numFmt = '0.0%';
      r3 += 2;
    }

    // Datos para gráfica de barras
    if (numSucursales > 1) {
      addSectionHeader(ws3, `A${r3}`, `E${r3}`, "VENTAS POR SUCURSAL  (seleccionar para gráfica de barras)");
      r3++;
      addTableHeaders(ws3, r3, ["Sucursal", "Total Ventas", "", "", ""]);
      r3++;
      resumenSucursal.forEach((s, i) => {
        const r = ws3.getRow(r3);
        r.values = [s.sucursal_id, Number(s.total_ventas), "", "", ""];
        r.getCell(2).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, 2);
        r3++;
      });
      r3++;

      // Tendencia semanal por sucursal
      addSectionHeader(ws3, `A${r3}`, `E${r3}`, "TENDENCIA SEMANAL POR SUCURSAL");
      r3++;

      const semanasUnicas = [...new Set(tendenciaSemanalSucursal.map(t => t.semana))].sort();
      const sucursalesEnTendencia = [...new Set(tendenciaSemanalSucursal.map(t => t.sucursal_id))].sort();

      const hdrsSem = ["Semana", ...sucursalesEnTendencia];
      addTableHeaders(ws3, r3, hdrsSem.length <= 5 ? [...hdrsSem, ...Array(5 - hdrsSem.length).fill("")] : hdrsSem.slice(0, 5));
      if (hdrsSem.length > 5) {
        const extraRow = ws3.getRow(r3);
        for (let c = 6; c <= hdrsSem.length; c++) {
          const cell = extraRow.getCell(c);
          cell.value = hdrsSem[c - 1];
          cell.font = { bold: true, size: 10, color: { argb: "FF2C3E50" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_BG}` } };
        }
      }
      r3++;

      const lookupSem = new Map<string, Map<string, number>>();
      tendenciaSemanalSucursal.forEach(t => {
        if (!lookupSem.has(t.semana)) lookupSem.set(t.semana, new Map());
        lookupSem.get(t.semana)!.set(t.sucursal_id, Number(t.total_semana));
      });

      semanasUnicas.forEach((sem, i) => {
        const vals: any[] = [formatDate(sem)];
        sucursalesEnTendencia.forEach(s => vals.push(lookupSem.get(sem)?.get(s) ?? 0));
        const r = ws3.getRow(r3);
        r.values = vals;
        for (let c = 2; c <= vals.length; c++) r.getCell(c).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, vals.length);
        r3++;
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // HOJA 4 — MÉTODOS DE PAGO
    // ─────────────────────────────────────────────────────────────────────
    const ws4 = workbook.addWorksheet("Métodos de Pago", { views: [{ showGridLines: false }] });
    ws4.columns = [{ width: 22 }, { width: 22 }, { width: 18 }, { width: 16 }, { width: 16 }];

    ws4.mergeCells("A1:E1");
    const t4 = ws4.getCell("A1");
    t4.value = "MÉTODOS DE PAGO — MONCAR POS";
    t4.font = { bold: true, size: 14, color: { argb: `FF${WHITE}` } };
    t4.fill = headerFill();
    t4.alignment = { horizontal: "center", vertical: "middle" };
    ws4.getRow(1).height = 28;

    ws4.mergeCells("A2:E2");
    const pc4 = ws4.getCell("A2");
    pc4.value = `Período: ${formatDate(fromDate)} — ${formatDate(toDate)}`;
    pc4.font = { italic: true, size: 10, color: { argb: "FF566573" } };
    pc4.fill = cellFill(LIGHT_BLUE);
    pc4.alignment = { horizontal: "center" };

    let r4 = 4;

    addSectionHeader(ws4, `A${r4}`, `E${r4}`, "DESGLOSE POR MÉTODO DE PAGO");
    r4++;

    if (resumenPagos.length > 0) {
      addTableHeaders(ws4, r4, ["Método", "Total Recaudado", "Num. Transacciones", "% del Total", ""]);
      r4++;
      resumenPagos.forEach((p, i) => {
        const total = Number(p.total);
        const pct = totalPagos > 0 ? total / totalPagos : 0;
        const r = ws4.getRow(r4);
        r.values = [p.metodo, total, Number(p.num_pagos), pct, ""];
        r.getCell(2).numFmt = '"$"#,##0.00';
        r.getCell(4).numFmt = '0.0%';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, 4);
        r4++;
      });

      const totalRowP = ws4.getRow(r4);
      totalRowP.values = ["TOTAL", totalPagos, resumenPagos.reduce((a, p) => a + Number(p.num_pagos), 0), 1, ""];
      totalRowP.eachCell(c => {
        c.font = { bold: true, color: { argb: `FF${WHITE}` } };
        c.fill = headerFill();
        c.border = thinBorder;
      });
      totalRowP.getCell(2).numFmt = '"$"#,##0.00';
      totalRowP.getCell(4).numFmt = '0.0%';
      r4 += 2;
    } else {
      addEmptyMessage(ws4, r4, 5, "Sin datos de pagos para el período seleccionado");
      r4 += 2;
    }

    // Datos para gráfica de pie
    addSectionHeader(ws4, `A${r4}`, `E${r4}`, "DISTRIBUCIÓN  (seleccionar para gráfica de pie)");
    r4++;
    addTableHeaders(ws4, r4, ["Método", "Total", "% del Total", "", ""]);
    r4++;
    resumenPagos.forEach((p, i) => {
      const total = Number(p.total);
      const pct = totalPagos > 0 ? total / totalPagos : 0;
      const r = ws4.getRow(r4);
      r.values = [p.metodo, total, pct, "", ""];
      r.getCell(2).numFmt = '"$"#,##0.00';
      r.getCell(3).numFmt = '0.0%';
      if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
      applyBorders(r, 3);
      r4++;
    });
    r4++;

    // Tendencia semanal por método
    addSectionHeader(ws4, `A${r4}`, `E${r4}`, "TENDENCIA SEMANAL POR MÉTODO");
    r4++;

    if (tendenciaSemanalPagos.length > 0) {
      const semanasP = [...new Set(tendenciaSemanalPagos.map(t => t.semana))].sort();
      const metodosP = [...new Set(tendenciaSemanalPagos.map(t => t.metodo))].sort();

      const hdrsPago = ["Semana", ...metodosP];
      addTableHeaders(ws4, r4, hdrsPago.length <= 5 ? [...hdrsPago, ...Array(5 - hdrsPago.length).fill("")] : hdrsPago.slice(0, 5));
      if (hdrsPago.length > 5) {
        const extraRow = ws4.getRow(r4);
        for (let c = 6; c <= hdrsPago.length; c++) {
          const cell = extraRow.getCell(c);
          cell.value = hdrsPago[c - 1];
          cell.font = { bold: true, size: 10, color: { argb: "FF2C3E50" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_BG}` } };
        }
      }
      r4++;

      const lookupP = new Map<string, Map<string, number>>();
      tendenciaSemanalPagos.forEach(t => {
        if (!lookupP.has(t.semana)) lookupP.set(t.semana, new Map());
        lookupP.get(t.semana)!.set(t.metodo, Number(t.total_semana));
      });

      semanasP.forEach((sem, i) => {
        const vals: any[] = [formatDate(sem)];
        metodosP.forEach(m => vals.push(lookupP.get(sem)?.get(m) ?? 0));
        const r = ws4.getRow(r4);
        r.values = vals;
        for (let c = 2; c <= vals.length; c++) r.getCell(c).numFmt = '"$"#,##0.00';
        if (i % 2 === 0) r.eachCell(c => { c.fill = cellFill(GRAY); });
        applyBorders(r, vals.length);
        r4++;
      });
    } else {
      addEmptyMessage(ws4, r4, 5, "Sin datos semanales de pagos");
      r4++;
    }

    // ─────────────────────────────────────────────────────────────────────
    // HOJA 5 — DETALLE
    // ─────────────────────────────────────────────────────────────────────
    const ws5 = workbook.addWorksheet("Detalle", { views: [{ showGridLines: false }] });

    ws5.columns = [
      { header: "Venta ID",  key: "venta_id",  width: 12 },
      { header: "Folio",     key: "folio",    width: 14 },
      { header: "Fecha",     key: "fecha",    width: 14 },
      { header: "Hora",      key: "hora",     width: 10 },
      { header: "Sucursal",  key: "sucursal", width: 14 },
      { header: "Estado",    key: "estado",   width: 14 },
      { header: "Método Pago", key: "metodo_pago", width: 24 },
      { header: "Total Pago",  key: "total_pago",  width: 16 },
      { header: "Subtotal",  key: "subtotal", width: 14 },
      { header: "IVA",       key: "iva",      width: 14 },
      { header: "Total",     key: "total",    width: 14 },
      { header: "Cancelada", key: "cancelada",width: 12 },
    ];

    const hdrRow5 = ws5.getRow(1);
    hdrRow5.eachCell(cell => {
      cell.fill = headerFill();
      cell.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = thinBorder;
    });
    hdrRow5.height = 22;

    ventasRows.forEach((v, i) => {
      const estadoLabel =
        v.estado_origen === "CO" ? "Completada" :
        v.estado_origen === "CA" ? "Cancelada"  : (v.estado_origen ?? "");

      const dataRow = ws5.addRow({
        venta_id: v.venta_id,
        folio:    v.folio_numero ?? "",
        fecha:    formatDate(v.usu_fecha),
        hora:     v.usu_hora ? v.usu_hora.substring(0, 5) : "",
        sucursal: v.sucursal_id ?? "",
        estado:   estadoLabel,
        metodo_pago: v.pagos_metodo_resumen ?? "",
        total_pago:  v.pagos_total_resumen ?? "",
        subtotal: Number(v.subtotal),
        iva:      Number(v.impuesto),
        total:    Number(v.total),
        cancelada: v.cancelada ? "Sí" : "No",
      });

      ["subtotal", "iva", "total"].forEach(key => {
        dataRow.getCell(key).numFmt = '"$"#,##0.00';
      });

      const bgColor = v.cancelada ? RED_BG : i % 2 === 0 ? GRAY : WHITE;
      dataRow.eachCell(cell => {
        cell.fill = cellFill(bgColor);
        cell.border = thinBorder;
        cell.alignment = { vertical: "middle" };
      });
      dataRow.getCell("total").font = { bold: true };
    });

    const lastDataRow = ws5.lastRow!.number;
    const totalesRow = ws5.addRow({
      folio:    "TOTAL",
      subtotal: { formula: `SUM(I2:I${lastDataRow})` },
      iva:      { formula: `SUM(J2:J${lastDataRow})` },
      total:    { formula: `SUM(K2:K${lastDataRow})` },
    });
    totalesRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: `FF${WHITE}` } };
      cell.fill = headerFill();
      cell.border = thinBorder;
    });
    ["subtotal", "iva", "total"].forEach(key => {
      totalesRow.getCell(key).numFmt = '"$"#,##0.00';
    });

    ws5.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: 12 },
    };

    // ── Enviar response ──────────────────────────────────────────────────
    const filename = `reporte_ventas_${fromDate}_${toDate}.xlsx`;

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    await workbook.xlsx.write(res);
    res.end();

    logger.info({
      from: fromDate, to: toDate, sucursal_id,
      rows: ventasRows.length,
      productos: productoVentas.length,
      sinMovimiento: sinMovimiento.length,
    }, "sales.report.generated");

  } catch (err) {
    logger.error({ err }, "sales.report.error");
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Error generando el reporte" });
    }
  }
});

export default router;
