import { httpConfiguration } from './http-security.js';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { configurationFailure, StartupDiagnosticError } from './startup-diagnostics.js';
export function validSigningSecret(value) {
  // Hex encoding of >=32 random bytes. Entropy provenance cannot be proven by validation.
  return typeof value === 'string' && /^[a-f0-9]{64,256}$/i.test(value) && value.length % 2 === 0 && new Set(value.toLowerCase()).size >= 12 && !/^(.{1,16})\1+$/i.test(value);
}
export function validateEnvironment(env) {
  try { return validateConfiguration(env); }
  catch(error) { throw configurationFailure(error); }
}
function validateConfiguration(env) {
  let uri;
  try {
    uri = new URL(env.MONGODB_URI);
    if (!['mongodb:','mongodb+srv:'].includes(uri.protocol) || !uri.hostname || !uri.pathname.slice(1) || /[<>\s]/.test(env.MONGODB_URI)) throw new Error();
  } catch { throw new Error('Invalid MONGODB_URI configuration'); }
  if (!validSigningSecret(env.JWT_SECRET)) throw new Error('JWT_SECRET must be hex encoding of at least 32 cryptographically random bytes');
  const portString = env.PORT ?? '5000';
  if (!/^\d+$/.test(String(portString)) || Number(portString)<1 || Number(portString)>65535) throw new Error('Invalid PORT configuration');
  const mode = env.NODE_ENV ?? 'development';
  if (!['development','test','production'].includes(mode)) throw new Error('Invalid NODE_ENV configuration');
  // AI is optional. Empty/example keys disable it without blocking manual workflows.
  const geminiApiKey=typeof env.GEMINI_API_KEY==='string'&&!/[<>\s]/.test(env.GEMINI_API_KEY)?env.GEMINI_API_KEY:'';
  const geminiModel=env.GEMINI_MODEL||'gemini-3.5-flash-lite';
  if(!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(geminiModel)) throw new Error('Invalid GEMINI_MODEL configuration');
  return Object.freeze({ mongodbUri: env.MONGODB_URI, jwtSecret: Buffer.from(env.JWT_SECRET,'hex'), port:Number(portString), mode, geminiApiKey, geminiModel, httpSecurity:httpConfiguration(env,mode) });
}
export async function loadEnvironment(env=process.env, path=new URL('../../.env',import.meta.url)) {
  let local={};
  try { local=parseEnv(await readFile(path,'utf8')); }
  catch(error) { if(error.code!=='ENOENT') throw new StartupDiagnosticError('ENVIRONMENT_LOAD_FAILED'); }
  return validateEnvironment({...local,...env});
}
