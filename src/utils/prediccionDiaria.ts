export interface PuntoPrediccionDiaria {
  fecha: string;           // YYYY-MM-DD
  monto_pred: number;
  tendencia: "subiendo" | "bajando" | "estable";
  confianza: number;
  dia_semana: number;
}

interface DatoHistorico {
  fecha: string;
  monto: number;
  dia_semana: number;
}

function promedio(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Clave del enfoque: los días de la semana tienen patrones distintos.
 * Un lunes típicamente vende diferente que un sábado.
 * Por eso calculamos el promedio ponderado POR DÍA DE SEMANA,
 * no sobre todos los días mezclados.
 */
export function calcularPrediccionDiaria(
  historial: DatoHistorico[],
  diasAdelante: number
): PuntoPrediccionDiaria[] {
  if (historial.length < 7) return [];

  // Agrupar historial por día de semana (0=dom, 1=lun, ... 6=sab)
  const porDiaSemana: Record<number, number[]> = {
    0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: []
  };

  historial.forEach(d => {
    porDiaSemana[d.dia_semana].push(d.monto);
  });

  // Promedio ponderado por día de semana
  // (semanas más recientes pesan más — las últimas 4 tienen doble peso)
  function promPonderadoDia(montos: number[]): number {
    if (!montos.length) return 0;
    const ultimas4 = montos.slice(-4);
    const resto    = montos.slice(0, -4);
    const todos    = [...resto, ...ultimas4, ...ultimas4]; // duplicar las recientes
    return promedio(todos);
  }

  const promediosPorDia: Record<number, number> = {};
  for (let d = 0; d <= 6; d++) {
    promediosPorDia[d] = promPonderadoDia(porDiaSemana[d]);
  }

  // Tendencia global: últimas 2 semanas vs las 2 anteriores
  const ultimas2semanas    = historial.slice(-14).map(d => d.monto);
  const anteriores2semanas = historial.slice(-28, -14).map(d => d.monto);
  const promReciente  = promedio(ultimas2semanas);
  const promAnterior  = promedio(anteriores2semanas);
  const tendenciaPct  = promAnterior > 0
    ? (promReciente - promAnterior) / promAnterior
    : 0;
  const tendencia = tendenciaPct > 0.05 ? "subiendo"
                  : tendenciaPct < -0.05 ? "bajando"
                  : "estable";

  // Confianza: qué tan consistente es la venta por día de semana
  const cvs = Object.values(porDiaSemana)
    .filter(arr => arr.length > 1)
    .map(arr => {
      const m = promedio(arr);
      const std = Math.sqrt(arr.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / arr.length);
      return m > 0 ? (std / m) * 100 : 100;
    });
  const cvPromedio = promedio(cvs);
  const confianza  = Math.round(Math.max(0, Math.min(100, 100 - cvPromedio)) * 100) / 100;

  // Generar predicciones para los próximos N días
  const predicciones: PuntoPrediccionDiaria[] = [];
  const hoy = new Date();

  for (let i = 1; i <= diasAdelante; i++) {
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + i);
    const dia_semana = fecha.getDay();

    // Ajuste suave por tendencia
    const factor = 1 + tendenciaPct * (i / diasAdelante) * 0.3;
    const monto_pred = Math.max(0,
      Math.round((promediosPorDia[dia_semana] * factor) * 100) / 100
    );

    predicciones.push({
      fecha:      fecha.toISOString().split("T")[0],
      monto_pred,
      tendencia,
      confianza,
      dia_semana,
    });
  }

  return predicciones;
}

export function calcularMAEDiario(historial: DatoHistorico[]): number {
  if (historial.length < 14) return 0;
  // Comparar la segunda mitad contra predicciones hechas con la primera mitad
  const mitad = Math.floor(historial.length / 2);
  const errores = historial.slice(mitad).map(d => {
    const similares = historial
      .slice(0, mitad)
      .filter(h => h.dia_semana === d.dia_semana)
      .map(h => h.monto);
    const pred = promedio(similares);
    return Math.abs(d.monto - pred);
  });
  return Math.round(promedio(errores) * 100) / 100;
}

export function calcularMAPEDiario(historial: DatoHistorico[]): number {
  if (historial.length < 14) return 0;
  const mitad = Math.floor(historial.length / 2);
  const errores = historial.slice(mitad)
    .map(d => {
      const similares = historial
        .slice(0, mitad)
        .filter(h => h.dia_semana === d.dia_semana)
        .map(h => h.monto);
      const pred = promedio(similares);
      return d.monto > 0 ? Math.abs(d.monto - pred) / d.monto * 100 : null;
    })
    .filter((e): e is number => e !== null);
  return Math.round(promedio(errores) * 100) / 100;
}
