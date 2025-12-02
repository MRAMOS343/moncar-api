-- ======================================
-- TABLA productos
-- ======================================
DROP TABLE IF EXISTS productos;

CREATE TABLE productos (
    sku           TEXT PRIMARY KEY,
    descrip       TEXT NOT NULL,
    linea         TEXT,
    marca         TEXT,
    precio1       NUMERIC(12,2),
    impuesto      NUMERIC(12,2),
    unidad        TEXT,
    minimo        NUMERIC(12,4),
    maximo        NUMERIC(12,4),
    costo_u       NUMERIC(12,4),
    cost_total    NUMERIC(14,2),
    notes         TEXT,
    image_url     TEXT,
    u1            TEXT,
    u2            TEXT,
    u3            TEXT,
    ubicacion     TEXT,
    movimientos   INT,
    clasificacion TEXT,
    rop           NUMERIC(12,4),
    rotacion      NUMERIC(12,4),
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_productos_marca  ON productos(marca);
CREATE INDEX idx_productos_linea  ON productos(linea);


-- ======================================
-- TABLA inventario
-- ======================================
DROP TABLE IF EXISTS inventario;

CREATE TABLE inventario (
    sku           TEXT NOT NULL,
    almacen       TEXT NOT NULL,
    existencia    NUMERIC(12,4) NOT NULL DEFAULT 0,  -- puede ser negativo si el POS lo maneja así
    actualizado_el TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (sku, almacen)
);

CREATE INDEX idx_inventario_sku     ON inventario(sku);
CREATE INDEX idx_inventario_almacen ON inventario(almacen);


-- ======================================
-- TABLA import_log (técnica para importación)
-- ======================================
DROP TABLE IF EXISTS import_log;

CREATE TABLE import_log (
    batch_id    UUID PRIMARY KEY,
    received_at TIMESTAMPTZ DEFAULT now(),
    source_id   TEXT NOT NULL,   -- ej. 'POS-MB-SUC-01'
    items       INT,
    ok          INT,
    dup         INT,
    error       INT,
    details     JSONB
);

CREATE INDEX idx_import_log_source   ON import_log(source_id);
CREATE INDEX idx_import_log_received ON import_log(received_at DESC);

