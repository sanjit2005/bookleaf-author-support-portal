import { readFile } from 'node:fs/promises';
import { IntegrationSafetyError } from './guards.js';

// Conservative source gate, checked before importing cases or opening a connection.
// Runtime capability views are the primary accidental-access boundary. This is
// deliberately not a sandbox for malicious JavaScript supplied by an adversary.
export function assertCaseSource(source) {
  const allowed=new Set(["import assert from 'node:assert/strict';","import bcrypt from 'bcrypt';","import { randomBytes } from 'node:crypto';"]);
  const imports=source.match(/^import[^\n]*;$/gm)??[];
  if(imports.some(line=>!allowed.has(line))||imports.length!==3)throw new IntegrationSafetyError('Unapproved integration-case import');
  const body=source.replace(/^import[^\n]*;$/gm,'');
  if(/\b(?:import|export\s+(?!const\s+integrationCases)|require|process|globalThis|global|eval|Function|Reflect|Proxy|constructor|__proto__|prototype|mongoose|MongoClient|models|collection|collections|connection|client|useDb|getClient|dbName|authdb|session|db)\b/.test(body))throw new IntegrationSafetyError('Unmediated integration-case database or runtime access is forbidden');
}
export async function reviewCases() {
  const url=new URL('./cases.js',import.meta.url),source=await readFile(url,'utf8');
  assertCaseSource(source);
}
export async function loadCases() {
  await reviewCases();
  return (await import('./cases.js')).integrationCases;
}
