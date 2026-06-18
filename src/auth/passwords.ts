/**
 * Password hashing (bcrypt cost 12).
 */
import bcrypt from 'bcrypt';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return await bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(plain, hash);
}

/** Basic validation matching UI hints. Throws Error with friendly message. */
export function validatePassword(plain: string): void {
  if (typeof plain !== 'string') throw new Error('Invalid password');
  if (plain.length < 8)         throw new Error('Password must be at least 8 characters');
  if (plain.length > 128)       throw new Error('Password is too long (max 128)');
}
