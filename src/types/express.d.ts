// src/types/express.d.ts
import type { AuthClaims } from "../middleware/requireAuth";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthClaims;
      user?: {
        id: string;
        role: string;
        sucursal_id: string | null;
        correo: string | null;
        // Compat con shapes alternativos de auth
        sub?: string;
        userId?: string;
        id_usuario?: string;
      };
    }
  }
}

export {};
