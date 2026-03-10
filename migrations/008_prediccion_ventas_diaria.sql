-- migrations/008_prediccion_ventas_diaria.sql

CREATE TABLE prediccion_diaria_cache (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id     TEXT,                        -- null = todas las sucursales
  fecha           DATE          NOT NULL,      -- fecha predicha
  monto_pred      NUMERIC(14,2) NOT NULL,      -- total de ventas predicho ese día
  monto_real      NUMERIC(14,2),               -- se llena cuando pasa el día
  tendencia       TEXT,                        -- 'subiendo' | 'bajando' | 'estable'
  confianza       NUMERIC(5,2),                -- 0–100
  dia_semana      INTEGER,                     -- 0=domingo ... 6=sábado (para patrones)
  calculado_en    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE(fecha, COALESCE(sucursal_id, ''))
);

CREATE TABLE prediccion_diaria_metricas (
  sucursal_id   TEXT,
  mae           NUMERIC(14,4),   -- error medio en pesos
  mape          NUMERIC(10,4),   -- error medio porcentual
  dias_data     INTEGER,
  calculado_en  TIMESTAMPTZ DEFAULT now(),

  PRIMARY KEY (COALESCE(sucursal_id, ''))
);

CREATE INDEX idx_pred_diaria_lookup
  ON prediccion_diaria_cache(sucursal_id, fecha DESC);
