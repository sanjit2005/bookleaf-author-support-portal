import { pathToFileURL } from 'node:url';
import { loadEnvironment } from '../config/environment.js';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { normalizeEmail } from '../auth/email.js';
import { promptLine } from './prompt.js';
import { parseSelection, prepareAccount, provisionAccount, checkInterrupted, ProvisionError, safeProvisionError } from './account.js';

export async function runProvisionCommand(args,{prompt=promptLine,loadConfig=loadEnvironment,connect=connectDatabase,disconnect=disconnectDatabase,signal}={}) {
  // Selection and credentials are validated before environment loading or connecting.
  const chosen=parseSelection(args);checkInterrupted(signal);
  const email=normalizeEmail(await prompt('Email: ',{signal}));
  if(!email) throw new ProvisionError('EMAIL');
  let password=await prompt('Password (hidden): ',{secret:true,signal});
  let confirmed=await prompt('Confirm password (hidden): ',{secret:true,signal});
  if(password!==confirmed) throw new ProvisionError('CONFIRM');
  const prepared=await prepareAccount({...chosen,email,password});
  password=undefined;confirmed=undefined;
  checkInterrupted(signal);
  const config=await loadConfig();checkInterrupted(signal);
  try {
    const db=await connect(config.mongodbUri);checkInterrupted(signal);
    const session=await db.startSession();
    try {
      await session.withTransaction(async()=>{checkInterrupted(signal);await provisionAccount(prepared,session,signal);checkInterrupted(signal);},{maxCommitTimeMS:5000});
      checkInterrupted(signal);
    } finally {await session.endSession();}
  } finally {await disconnect();}
}
async function main() {
  const controller=new AbortController();
  const interrupt=()=>controller.abort();
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {await runProvisionCommand(process.argv.slice(2),{signal:controller.signal});console.log('Account provisioned successfully.');}
  catch(error){console.error(safeProvisionError(error));process.exitCode=1;}
  finally {process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) void main();
