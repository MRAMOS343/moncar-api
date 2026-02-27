// src/utils/http.ts
import { Request, Response, NextFunction } from "express";

/**
 * Error HTTP tipado para usar con el error handler global.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

/**
 * Wrapper para handlers async que captura errores y los pasa a next().
 */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<any>>(
  fn: T
) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}
