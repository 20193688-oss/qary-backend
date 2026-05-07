import bcrypt from 'bcryptjs';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10);

export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
