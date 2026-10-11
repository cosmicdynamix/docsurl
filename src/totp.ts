import { authenticator } from 'otplib';
import { decrypt } from './crypto.js';
import { pool } from './db.js';

authenticator.options = { window: 1 }; // tolerate +-30s clock drift

/**
 * Verify a TOTP code and reject replays: a code (time step) can be used only once per user.
 * Returns true when the code is valid and has not been used before.
 */
export async function verifyTotp(userId: string, secretEnc: string, code: string): Promise<boolean> {
  const delta = authenticator.checkDelta(code.replace(/\s/g, ''), decrypt(secretEnc));
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30_000) + delta;
  const { rowCount } = await pool.query(
    'update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2)',
    [userId, step],
  );
  return rowCount === 1;
}
