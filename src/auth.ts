import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

export function signToken(userId: string, email: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');
  return jwt.sign({ sub: userId, email }, secret, { expiresIn: '30d' });
}

export type Authed = { id: string; email: string };

export function optionalUser(req: Request): Authed | null {
  const header = req.header('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET) as { sub?: string; email?: string };
    if (!payload.sub || !payload.email) return null;
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = optionalUser(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in again to continue.' });
    return;
  }
  (req as Request & { user: Authed }).user = user;
  next();
}

export async function verifyGoogleIdToken(idToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('Google sign-in needs GOOGLE_CLIENT_ID on the server.');
  }
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const info = (await response.json()) as { aud?: string; sub?: string; email?: string; name?: string; email_verified?: string; error_description?: string };
  if (!response.ok || !info.sub || !info.email) {
    throw new Error(info.error_description || 'Google token was rejected.');
  }
  if (info.aud !== clientId) throw new Error('Google token was issued for a different client.');
  if (info.email_verified === 'false') throw new Error('That Google email is not verified.');
  return { sub: info.sub, email: info.email.toLowerCase(), name: info.name || info.email.split('@')[0] };
}
