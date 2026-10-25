import { User } from '../models/index.js';
export function normalizeEmail(value) {
  if(typeof value!=='string') return null;
  const email=value.trim().toLowerCase();
  return email.length<=254 && User.schema.path('email').options.match.test(email) ? email : null;
}
