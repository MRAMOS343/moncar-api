-- =========================================================
-- MIGRACIÓN 002: INVITATION TOKENS + COLUMNAS USUARIOS
-- =========================================================

-- ============================
-- Columnas nuevas en usuarios
-- ============================

-- invited_by: UUID del admin que creó la invitación
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES usuarios(id_usuario);

-- activated_at: momento en que el usuario activó su cuenta
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;


-- ============================
-- TABLA invitation_tokens
-- ============================

CREATE TABLE IF NOT EXISTS invitation_tokens (
    token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id  UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    tipo        TEXT NOT NULL DEFAULT 'invitation',      -- 'invitation' | 'password_reset' (extensible)
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '48 hours'),
    used_at     TIMESTAMPTZ,                             -- NULL = vigente
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invitation_tokens_usuario
  ON invitation_tokens(usuario_id);

CREATE INDEX IF NOT EXISTS idx_invitation_tokens_expires
  ON invitation_tokens(expires_at)
  WHERE used_at IS NULL;
