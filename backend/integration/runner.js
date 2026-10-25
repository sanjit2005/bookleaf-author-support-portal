import { IntegrationSafetyError } from './guards.js';

// Import-safe orchestration only. Database and case loading are explicit dependencies.
export async function runIntegration(env,{open,load,cases,report=console.log,execArgv=process.execArgv,signal}={}) {
  let harness,failed=0,passed=0,skipped=0;
  try {
    if(typeof open!=='function'||(!cases&&typeof load!=='function'))throw new IntegrationSafetyError('Explicit integration dependencies are required');
    const approvedCases=cases??await load();
    harness=await open(env,{execArgv,signal});
    for(const [name,work] of approvedCases) {
      if(signal?.aborted)throw new IntegrationSafetyError('Integration run interrupted; cleanup requested');
      try {
        await harness.clearRecords();
        const result=await harness.runCase(work);
        if(result===false){skipped++;report(name+': SKIP (set TEST_SOURCE_DATA_PATH to the original fingerprint-verified JSON)');}
        else {passed++;report(name+': PASS');}
      } catch(error) {
        failed++;report(name+': FAIL (details suppressed to protect configuration and source data)');
        if(error instanceof IntegrationSafetyError)throw error;
      }
    }
  } finally {if(harness)await harness.close();}
  report(`Integration results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed?1:skipped?2:0;
}
