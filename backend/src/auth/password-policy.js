import bcrypt from 'bcrypt';
export const BCRYPT_COST = 12;
export const NEW_PASSWORD_MIN_LENGTH = 12;
// Login retains the legacy input rules; never apply the new-account minimum here.
export function validPasswordInput(value) {
  return typeof value==='string' && value.length>0 && Buffer.byteLength(value,'utf8')<=72 && !value.includes('\0');
}
export function validPasswordCharacters(value) {
  return typeof value==='string' && value.isWellFormed() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
export function validNewPasswordInput(value) {
  return validPasswordInput(value) && validPasswordCharacters(value) && Array.from(value).length>=NEW_PASSWORD_MIN_LENGTH;
}
export function validPasswordHash(value) {
  if (typeof value !== 'string' || !/^\$2[ab]\$(10|11|12|13|14)\$[./A-Za-z0-9]{53}$/.test(value)) return false;
  try { const rounds=bcrypt.getRounds(value); return rounds>=10 && rounds<=14; } catch { return false; }
}
