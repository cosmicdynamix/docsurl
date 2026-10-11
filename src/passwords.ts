import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'Password must contain letters and numbers');

export const hashPassword = (p: string): Promise<string> => hash(p);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

// A real hash computed at startup so login takes similar time for unknown e-mails.
export const DUMMY_HASH = await hash('not-a-real-password-0');
