-- Agrega campos estructurados de cliente para soporte de cotizaciones/ventas.
-- Se mantiene cliente_origen/datos_origen para compatibilidad histórica.

ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS cliente_nombre TEXT,
  ADD COLUMN IF NOT EXISTS cliente_telefono VARCHAR(30),
  ADD COLUMN IF NOT EXISTS cliente_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cliente_empresa VARCHAR(150);

CREATE INDEX IF NOT EXISTS idx_ventas_cliente_email ON ventas (cliente_email);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente_telefono ON ventas (cliente_telefono);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente_empresa ON ventas (cliente_empresa);
