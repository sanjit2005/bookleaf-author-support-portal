import { ambiguousTransactionError, bounded } from './lifecycle.js';
import { IntegrationSafetyError } from './guards.js';
import { requireTransaction } from '../src/db/transaction.js';

function identifier(value) {
  if(Buffer.isBuffer(value)||value instanceof Uint8Array)return Buffer.from(value);
  if(value?._bsontype==='Binary')return Buffer.from(value.value());
  return null;
}
function requestKey(event) {
  if(!Number.isInteger(event.requestId)||event.connectionId==null||typeof event.address!=='string')return null;
  return JSON.stringify([event.address,String(event.connectionId),event.serviceId?.toHexString?.()??'',event.requestId]);
}

// Observe only session/transaction identifiers and terminal acknowledgement state.
// Never retain/log full commands, replies, failures, ticket content or credentials.
export function observeTransaction(client,session,markUncertain) {
  if(typeof client?.on!=='function'||typeof client?.off!=='function')throw new IntegrationSafetyError('Transaction acknowledgement observation is unavailable');
  const id=identifier(session.id?.id);
  if(id?.length!==16)throw new IntegrationSafetyError('Transaction session identity cannot be verified');
  let attempt=null,previousNumber=null,failed=false,disposed=false;
  const pending=new Map(),used=new Set();
  const uncertain=()=>{failed=true;if(attempt)attempt.terminal=null;markUncertain();};
  const terminalCommand=kind=>kind==='commitTransaction'||kind==='abortTransaction';
  // Each withTransaction callback invocation is a distinct attempt. Only its
  // commands may bind its transaction number; a prior abort is never transferable.
  // No new attempt, acknowledgement, retry or session close can reset failure.
  function beginAttempt() {
    if(attempt) {
      if(attempt.terminal!=='abort'||pending.size)uncertain();
      previousNumber=attempt.number;
    }
    const token=Symbol('transaction attempt');
    attempt={token,number:null,terminal:null,state:'running',error:null};
    return token;
  }
  function finishAttempt(token,error,rejected=false) {
    if(attempt?.token!==token||attempt.state!=='running'){uncertain();return;}
    attempt.state=rejected?'rejected':'fulfilled';attempt.error=error;
  }
  function started(event) {
    const final=terminalCommand(event.commandName),observed=identifier(event.command?.lsid?.id);
    // Missing identity cannot safely be attributed to another session. Refuse
    // cleanup conservatively, including after an apparently complete terminal ACK.
    if(observed?.length!==16) {
      if(final||event.command?.txnNumber!==undefined||event.command?.autocommit===false)uncertain();
      return;
    }
    if(!observed.equals(id))return;
    const number=event.command?.txnNumber?.toString();
    if(!attempt||event.command?.autocommit!==false||!/^\d+$/.test(number??'')){uncertain();return;}
    if(attempt.number===null) {
      if(previousNumber!==null&&BigInt(number)<=BigInt(previousNumber))uncertain();
      attempt.number=number;
    } else if(attempt.number!==number){uncertain();return;}
    // All activity after a terminal result requires a new callback attempt.
    if(attempt.terminal!==null||pending.size){uncertain();return;}
    if(!final)return;
    const key=requestKey(event);
    if(!key||used.has(key)||pending.size||event.databaseName!=='admin'){uncertain();return;}
    used.add(key);pending.set(key,{kind:event.commandName,number,token:attempt.token});
  }
  function completed(event,succeeded) {
    const key=requestKey(event),command=pending.get(key);
    // Completion events carry no lsid/txnNumber. An unmatched terminal event
    // therefore cannot be assumed unrelated, or be allowed to preserve stale proof.
    if(!command){if(terminalCommand(event.commandName)||used.has(key)||typeof event.commandName!=='string')uncertain();return;}
    pending.delete(key);
    if(!succeeded||event.commandName!==command.kind||event.databaseName!=='admin'||command.token!==attempt?.token||command.number!==attempt.number
      ||event.reply?.ok!==1||event.reply.writeConcernError||event.reply.writeErrors?.length||event.reply.errorLabels?.length) {uncertain();return;}
    if(!failed)attempt.terminal=command.kind==='commitTransaction'?'commit':'abort';
  }
  const succeeded=event=>completed(event,true),failure=event=>completed(event,false);
  client.on('commandStarted',started);client.on('commandSucceeded',succeeded);client.on('commandFailed',failure);
  return Object.freeze({
    beginAttempt,finishAttempt,
    confirmed:(kind,error)=>!disposed&&!failed&&pending.size===0&&attempt?.terminal===kind
      &&(kind==='abort'?attempt.state==='rejected'&&attempt.error===error:attempt.state==='fulfilled'),
    assertCommit(){if(!this.confirmed('commit')){uncertain();throw new IntegrationSafetyError('Transaction commit was not confirmed; cleanup refused');}},
    assertSettled(){if(failed||pending.size){uncertain();throw new IntegrationSafetyError('Transaction terminal outcome is uncertain; cleanup refused');}},
    dispose(){if(disposed)return;disposed=true;client.off('commandStarted',started);client.off('commandSucceeded',succeeded);client.off('commandFailed',failure);},
  });
}

export function createTransactionRunner({connection,lifecycle,sessions,check,signal,timeoutMs=10000,finalizeTimeoutMs=5000}) {
  return work=>{
    const safeAborts=new WeakSet(),proof={confirmedAbort:error=>error instanceof Error&&safeAborts.has(error)};
    return lifecycle.track('transaction',async()=>{
      // The driver promise remains tracked after a caller deadline. Finalization
      // waits for actual driver settlement, never runs concurrently with it.
      const driver=lifecycle.track('transaction-driver',async()=>{
        check();const active=await connection.startSession();sessions.add(active);
        let evidence;
        try {
          evidence=observeTransaction(connection.getClient(),active,lifecycle.markUncertain);
          try {
            const result=await active.withTransaction(async()=>{
              const token=evidence.beginAttempt();
              try {check();requireTransaction(active);const value=await work(active);evidence.finishAttempt(token);return value;}
              catch(error){evidence.finishAttempt(token,error,true);throw error;}
            },
              {readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:5000,timeoutMS:timeoutMs});
            if(signal?.aborted){lifecycle.markUncertain();throw new IntegrationSafetyError('Transaction interrupted; cleanup refused');}
            evidence.assertCommit();return result;
          } catch(error) {
            if(error instanceof Error&&!signal?.aborted&&!ambiguousTransactionError(error)&&evidence.confirmed('abort',error))safeAborts.add(error);
            else lifecycle.markUncertain();
            throw error;
          }
        } finally {
          try {
            const finalizing=lifecycle.track('transaction-finalization',async()=>{
              try {await active.endSession();evidence?.assertSettled();}
              finally {evidence?.dispose();sessions.delete(active);}
            });
            await bounded(()=>finalizing,finalizeTimeoutMs);
          } catch {lifecycle.markUncertain();throw new IntegrationSafetyError('Integration transaction finalization is uncertain; cleanup refused');}
        }
      },proof);
      try {return await bounded(()=>driver,timeoutMs+finalizeTimeoutMs);}
      catch(error) {if(!proof.confirmedAbort(error))lifecycle.markUncertain();throw error;}
    },proof);
  };
}
