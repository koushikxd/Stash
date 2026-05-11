import { timingSafeEqual } from 'crypto';

export function verifyBearer(headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false;
  const prefix = 'Bearer ';
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length).trim();
  if (provided.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}
