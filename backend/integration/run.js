import { runIntegration } from './runner.js';
import { pathToFileURL } from 'node:url';
import { openHarness } from './harness.js';
import { loadCases } from './case-policy.js';
import { IntegrationSafetyError } from './guards.js';

async function main() {
  const controller=new AbortController(),interrupt=()=>controller.abort();
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {process.exitCode=await runIntegration(process.env,{open:openHarness,load:loadCases,execArgv:process.execArgv,signal:controller.signal});}
  catch(error){console.error(error instanceof IntegrationSafetyError?error.message:'Integration run failed (details suppressed)');process.exitCode=1;}
  finally {process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
