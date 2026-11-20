import { scrypt } from 'node:crypto';

export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_MIN_LENGTH = 12;
const HEX = /^[a-f0-9]{64}$/;

export function randomHex(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}
export function passwordHash(password: string, salt: string): Promise<string> {
  // OWASP scrypt profile: N=2^15, r=8, p=3. Requires nodejs_compat on Workers.
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(hex(key));
    });
  });
}
export function hashesEqual(left: string, right: string): boolean {
  if (!HEX.test(left) || !HEX.test(right)) return false;
  let different = 0;
  for (let index = 0; index < 64; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}
