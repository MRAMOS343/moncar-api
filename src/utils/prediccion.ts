// src/utils/prediccion.ts

export interface PuntoPrediccion {
  semana_inicio: string;
  unidades_pred: number;
  tendencia: "subiendo" | "bajando" | "estable";
  confianza: number;
}

function promedio(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function siguienteLunes(): Date {
  const hoy = new Date();
  const diasParaLunes = (8 - hoy.getDay()) % 7 || 7;
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() + diasParaLunes);
  lunes.setHours(0, 0, 0, 0);
  return lunes;
}

/**
 * Recibe array de unidades vendidas por semana (más reciente primero)
 * y retorna las predicciones para las próximas N semanas.
 */
export function calcularPrediccion(
  valoresMasRecientePrimero: number[],
  horizonteSemanas: number
): PuntoPrediccion[] {
  const valores = valoresMasRecientePrimero;
  if (valores.length < 2) return [];

  // Promedio ponderado — semana más reciente tiene más peso
  const ultimas = valores.slice(0, Math.min(8, valores.length));
  const pesos   = ultimas.map((_, i) => ultimas.length - i);
  const sumPesos = pesos.reduce((a, b) => a + b, 0);
  const promPonderado = ultimas.reduce((acc, v, i) => acc + v * pesos[i], 0) / sumPesos;

  // Tendencia: últimas 4 semanas vs las 4 anteriores
  const prom4r = promedio(valores.slice(0, 4));
  const prom4a = promedio(valores.slice(4, 8));
  const tendenciaPct = prom4a > 0 ? (prom4r - prom4a) / prom4a : 0;
  const tendencia = tendenciaPct > 0.1 ? "subiendo"
                  : tendenciaPct < -0.1 ? "bajando"
                  : "estable";

  // Confianza: qué tan consistente es el historial (inverso del coef. de variación)
  const media = promedio(valores);
  const stdDev = Math.sqrt(
    valores.reduce((acc, v) => acc + Math.pow(v - media, 2), 0) / valores.length
  );
  const cv = media > 0 ? (stdDev / media) * 100 : 100;
  const confianza = Math.round(Math.max(0, Math.min(100, 100 - cv)) * 100) / 100;

  // Proyectar semanas futuras
  const lunes = siguienteLunes();
  const predicciones: PuntoPrediccion[] = [];

  for (let i = 0; i < horizonteSemanas; i++) {
    const fecha = new Date(lunes);
    fecha.setDate(lunes.getDate() + i * 7);

    // Factor de tendencia suavizado para no exagerar en semanas lejanas
    const factor = 1 + tendenciaPct * (i / horizonteSemanas) * 0.5;
    const unidades_pred = Math.round(Math.max(0, promPonderado * factor) * 100) / 100;

    predicciones.push({
      semana_inicio: fecha.toISOString().split("T")[0],
      unidades_pred,
      tendencia,
      confianza,
    });
  }

  return predicciones;
}

/** MAE — error medio en unidades */
export function calcularMAE(valoresMasRecientePrimero: number[]): number {
  const v = valoresMasRecientePrimero;
  if (v.length < 4) return 0;
  const errores = v.slice(0, -2).map((val, i) => {
    const predicho = promedio(v.slice(i + 1, i + 4));
    return Math.abs(val - predicho);
  });
  return Math.round(promedio(errores) * 100) / 100;
}

/** MAPE — error medio en porcentaje */
export function calcularMAPE(valoresMasRecientePrimero: number[]): number {
  const v = valoresMasRecientePrimero;
  if (v.length < 4) return 0;
  const errores = v.slice(0, -2)
    .map((val, i) => {
      const predicho = promedio(v.slice(i + 1, i + 4));
      return val > 0 ? Math.abs(val - predicho) / val * 100 : null;
    })
    .filter((e): e is number => e !== null);
  return Math.round(promedio(errores) * 100) / 100;
}
