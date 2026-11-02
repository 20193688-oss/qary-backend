/** Error de dominio con código estable y status HTTP. Nunca se traga: el handler global lo registra con contexto. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export const badRequest = (code: string, msg: string, d?: unknown) => new AppError(code, 400, msg, d);
export const forbidden = (code: string, msg: string, d?: unknown) => new AppError(code, 403, msg, d);
export const notFound = (code: string, msg: string) => new AppError(code, 404, msg);
export const conflict = (code: string, msg: string, d?: unknown) => new AppError(code, 409, msg, d);
