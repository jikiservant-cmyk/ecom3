/**
 * Shared input-validation helpers for API routes.
 * All routes fail closed: malformed input => 400, never a thrown 500.
 */

export const MAX_JSON_BYTES = 256 * 1024;

/** Parse a JSON body with a size cap and safe error handling. */
export async function readJsonBody(req: Request, maxBytes = MAX_JSON_BYTES): Promise<any | null> {
  try {
    const length = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(length) && length > maxBytes) return null;
    const text = await req.text();
    if (text.length > maxBytes) return null;
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isNonEmptyString(v: unknown, maxLen = 500): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maxLen;
}

export function isEmail(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length > 320) return false;
  // Pragmatic RFC-lite check; Supabase Auth re-validates on its side.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isIntInRange(v: unknown, min: number, max: number): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= min && v <= max;
}

/** Strip control characters and collapse whitespace for free-text fields. */
export function sanitizeText(v: string, maxLen: number): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

export function jsonError(message: string, status: number) {
  return Response.json({ success: false, error: message }, { status });
}
