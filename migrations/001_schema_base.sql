-- =========================================================
-- MIGRACIÓN INICIAL: ESQUEMA BASE MONCAR
-- ATENCIÓN: DROP TABLE borra datos; usar en base vacía
-- =========================================================

-- ============================
-- TIPOS ENUM
-- ============================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_metodo_pago') THEN
        CREATE TYPE tipo_metodo_pago AS ENUM (
            'efectivo',
            'debito',
            'credito',
            'transferencia',
            'cheque',
            'otro'
        );
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_rol_usuario') THEN
        CREATE TYPE tipo_rol_usuario AS ENUM ('admin', 'gerente', 'cajero');
    END IF;
END;
$$;

-- ============================
-- DROP TABLES (LIMPIEZA)
-- ============================
-- Orden para evitar problemas de FK; CASCADE por si hay dependencias

DROP TABLE IF EXISTS roles_usuario          CASCADE;
DROP TABLE IF EXISTS usuarios               CASCADE;
DROP TABLE IF EXISTS sucursales             CASCADE;

DROP TABLE IF EXISTS pagos_venta            CASCADE;
DROP TABLE IF EXISTS lineas_venta           CASCADE;
DROP TABLE IF EXISTS ventas                 CASCADE;

DROP TABLE IF EXISTS inventario             CASCADE;
DROP TABLE IF EXISTS productos              CASCADE;
DROP TABLE IF EXISTS import_log             CASCADE;
DROP TABLE IF EXISTS estado_sincronizacion  CASCADE;

-- ============================
-- TABLA productos
-- ============================

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


-- ============================
-- TABLA inventario
-- ============================

CREATE TABLE inventario (
    sku            TEXT NOT NULL,
    almacen        TEXT NOT NULL,
    existencia     NUMERIC(12,4) NOT NULL DEFAULT 0,   -- puede ser negativo
    actualizado_el TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (sku, almacen)
);

CREATE INDEX idx_inventario_sku     ON inventario(sku);
CREATE INDEX idx_inventario_almacen ON inventario(almacen);


-- ============================
-- TABLA import_log
-- ============================

CREATE TABLE import_log (
    batch_id    UUID PRIMARY KEY,
    received_at TIMESTAMPTZ DEFAULT now(),
    source_id   TEXT NOT NULL,   -- p.ej. 'POS-MB-SUC-01'
    items       INT,
    ok          INT,
    dup         INT,
    error       INT,
    details     JSONB
);

CREATE INDEX idx_import_log_source   ON import_log(source_id);
CREATE INDEX idx_import_log_received ON import_log(received_at DESC);


-- ============================
-- TABLA ventas
-- ============================

CREATE TABLE ventas (
    id_venta         BIGINT PRIMARY KEY,        -- VENTA del POS
    fecha_hora_local TIMESTAMPTZ NOT NULL,      -- F_EMISION
    sucursal_pos     TEXT,                      -- SUCURSAL (texto crudo del POS)
    caja             TEXT,                      -- Caja/terminal
    folio_serie      TEXT,                      -- serieDocumento
    folio_numero     TEXT,                      -- NO_REFEREN u otro
    subtotal         NUMERIC(12,2) NOT NULL,
    impuesto         NUMERIC(12,2) NOT NULL,
    total            NUMERIC(12,2) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ventas_fecha    ON ventas(fecha_hora_local DESC);
CREATE INDEX idx_ventas_sucursal ON ventas(sucursal_pos);
CREATE INDEX idx_ventas_total    ON ventas(total);


-- ============================
-- TABLA lineas_venta
-- ============================

CREATE TABLE lineas_venta (
    id_venta        BIGINT NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
    numero_linea    INT    NOT NULL,
    sku             TEXT   NOT NULL,
    cantidad        NUMERIC(12,4) NOT NULL,
    precio_unitario NUMERIC(12,4) NOT NULL,
    descuento       NUMERIC(12,4) NOT NULL DEFAULT 0,
    total_linea     NUMERIC(12,2) NOT NULL,
    almacen_pos     TEXT,
    PRIMARY KEY (id_venta, numero_linea),
    CONSTRAINT fk_lineas_venta_producto
        FOREIGN KEY (sku) REFERENCES productos(sku) ON UPDATE CASCADE
);

CREATE INDEX idx_lineas_venta_sku ON lineas_venta(sku);
CREATE INDEX idx_lineas_venta_alm ON lineas_venta(almacen_pos);


-- ============================
-- TABLA pagos_venta
-- ============================

CREATE TABLE pagos_venta (
    id_venta   BIGINT NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
    indice     INT    NOT NULL,                   -- 1,2,3,...
    metodo     tipo_metodo_pago NOT NULL,
    monto      NUMERIC(12,2) NOT NULL,
    PRIMARY KEY (id_venta, indice)
);

CREATE INDEX idx_pagos_venta_metodo ON pagos_venta(metodo);


-- ============================
-- TABLA estado_sincronizacion
-- ============================

CREATE TABLE estado_sincronizacion (
    id_fuente       TEXT PRIMARY KEY,            -- p.ej. 'POS-MB-SUC-01'
    ultimo_id_venta BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT now()
);


-- ============================
-- TABLA sucursales
-- ============================

CREATE TABLE sucursales (
    id_sucursal    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(100) NOT NULL,
    direccion      VARCHAR(500),
    telefono       VARCHAR(20),
    activo         BOOLEAN DEFAULT TRUE,
    creado_en      TIMESTAMPTZ DEFAULT now(),
    actualizado_en TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sucursales_nombre ON sucursales(nombre);
CREATE INDEX idx_sucursales_activo ON sucursales(activo);


-- ============================
-- TABLA usuarios
-- ============================

CREATE TABLE usuarios (
    id_usuario     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(100) NOT NULL,
    correo         VARCHAR(255) NOT NULL UNIQUE,
    telefono       VARCHAR(20),
    avatar_url     TEXT,
    sucursal_id    UUID REFERENCES sucursales(id_sucursal),
    password_hash  TEXT,                          -- manejado por la API (bcrypt/argon2)
    activo         BOOLEAN DEFAULT TRUE,
    creado_en      TIMESTAMPTZ DEFAULT now(),
    actualizado_en TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usuarios_sucursal ON usuarios(sucursal_id);
CREATE INDEX idx_usuarios_activo   ON usuarios(activo);


-- ============================
-- TABLA roles_usuario
-- ============================

CREATE TABLE roles_usuario (
    id_rol_usuario UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario     UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    rol            tipo_rol_usuario NOT NULL DEFAULT 'cajero',
    creado_en      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (id_usuario, rol)
);

CREATE INDEX idx_roles_usuario_usuario ON roles_usuario(id_usuario);
CREATE INDEX idx_roles_usuario_rol     ON roles_usuario(rol);


-- ============================
-- FUNCIONES AUXILIARES (ROLES)
-- ============================

CREATE OR REPLACE FUNCTION tiene_rol(_id_usuario UUID, _rol tipo_rol_usuario)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM roles_usuario
        WHERE id_usuario = _id_usuario
          AND rol = _rol
    );
$$;

CREATE OR REPLACE FUNCTION es_admin(_id_usuario UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
    SELECT tiene_rol(_id_usuario, 'admin'::tipo_rol_usuario);
$$;

