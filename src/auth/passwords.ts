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
  if (typeof plain !== 'string') throw new Error('Mật khẩu không hợp lệ');
  if (plain.length < 8)         throw new Error('Mật khẩu phải ít nhất 8 ký tự');
  if (plain.length > 128)       throw new Error('Mật khẩu quá dài (max 128)');
}
