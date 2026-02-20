import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id?: string;          // UUID string
        equipo_id?: string;   // tenant/sucursal
        roles?: string[];
      };
    }
  }
}

export {};
