// Session/client objects below are fakes. No MongoClient or real connection opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLifecycle } from '../integration/lifecycle.js';
import { createTransactionRunner } from '../integration/transaction.js';
import { IntegrationSafetyError } from '../integration/guards.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const failure=(name='Error')=>Object.assign(new Error('Synthetic transaction failure'),{name});
const unknown=()=>Object.assign(failure('MongoServerError'),{hasErrorLabel:label=>label==='UnknownTransactionCommitResult'});

function fixture({behavior,finalize=async()=>{},signal,timeoutMs=100,finalizeTimeoutMs=30}={}) {
  const client=new EventEmitter(),sessions=new Set(),life=createLifecycle({signal,timeoutMs:30});
  let request=0,ends=0,deletions=0,cleanups=0,sequence=0,session;
  function makeSession() {
    const active={id:{id:Buffer.alloc(16,++sequence)},hasEnded:false,inTransaction:()=>true,
      withTransaction:async callback=>behavior?behavior({callback,emit:(kind,options={})=>emit(kind,{lsid:active.id,...options}),session:active,client}):callback(),
      endSession:async()=>{ends++;await finalize();active.hasEnded=true;},
    };
    return active;
  }
  function emit(kind,{ok=true,reply={ok:1},lsid=session.id,txnNumber=1,connectionId=1,address='fixture',databaseName='admin',complete=true,requestId=++request}={}) {
    const event={commandName:kind,requestId,connectionId,address,databaseName};
    client.emit('commandStarted',{...event,command:{lsid,txnNumber,autocommit:false}});
    if(complete)client.emit(ok?'commandSucceeded':'commandFailed',{...event,reply,failure:failure()});
    return event;
  }
  const connection={startSession:async()=>{session=makeSession();return session;},getClient:()=>client};
  const run=createTransactionRunner({connection,lifecycle:life,sessions,check:()=>life.admit(),signal,timeoutMs,finalizeTimeoutMs});
  const deleteFixtures=async()=>{deletions++;};
  const cleanup=()=>life.maintain(async()=>{cleanups++;await deleteFixtures();});
  return {client,get session(){return session;},sessions,life,run,cleanup,emit,ends:()=>ends,cleanups:()=>cleanups,deletions:()=>deletions};
}
async function blocked(h) {
  await assert.rejects(h.cleanup(),IntegrationSafetyError);assert.equal(h.cleanups(),0);assert.equal(h.deletions(),0);
  await assert.rejects(h.cleanup(),IntegrationSafetyError);assert.equal(h.cleanups(),0);assert.equal(h.deletions(),0);
}

for(const [name,error] of [['unlabelled network error',failure('MongoNetworkError')],['transaction timeout',failure('MongoOperationTimeoutError')],['unknown commit result',unknown()],['unclassified rejection',failure()]]) {
  test(name+' permanently refuses deletion even after session closure resolves',async()=>{
    const h=fixture({behavior:async()=>{throw error;}});
    await assert.rejects(h.run(async()=>{}),e=>e===error);
    assert.equal(h.ends(),1);assert.equal(h.session.hasEnded,true);await blocked(h);
  });
  test('lifecycle defaults fail closed for '+name+' without a terminal proof',async()=>{
    const life=createLifecycle();let deletions=0;
    await assert.rejects(life.track('transaction',async()=>{throw error;}));
    await assert.rejects(life.maintain(async()=>{deletions++;}),IntegrationSafetyError);assert.equal(deletions,0);
  });
}
test('abort rejection blocks deletion while endSession still resolves',async()=>{
  const h=fixture({behavior:async({callback,emit,session})=>{
    session.abortTransaction=async()=>{emit('abortTransaction',{ok:false});throw failure('MongoNetworkError');};
    try {await callback();}catch {await session.abortTransaction();}
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));assert.equal(h.ends(),1);await blocked(h);
});
test('driver-suppressed abort failure and resolved endSession cannot confirm rollback',async()=>{
  const h=fixture({behavior:async({callback,emit,session})=>{
    session.abortTransaction=async()=>{try {emit('abortTransaction',{ok:false});throw failure('MongoNetworkError');}catch{/* Driver-like suppression. */}};
    try {await callback();}catch(error){await session.abortTransaction();throw error;}
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));assert.equal(h.session.hasEnded,true);await blocked(h);
});
test('resolved abort promise without wire evidence remains unsafe',async()=>{
  const h=fixture({behavior:async({callback,session})=>{
    session.abortTransaction=async()=>{};
    try {await callback();}catch(error){await session.abortTransaction();throw error;}
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});
test('only matching clean commit acknowledgement plus completion permits cleanup',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{const value=await callback();emit('commitTransaction');return value;}});
  assert.equal(await h.run(async()=>42),42);assert.equal(h.ends(),1);assert.equal(h.sessions.size,0);
  await h.cleanup();assert.equal(h.deletions(),1);
  for(const event of ['commandStarted','commandSucceeded','commandFailed'])assert.equal(h.client.listenerCount(event),0);
});
test('a matching clean abort acknowledgement permits an expected application rollback',async()=>{
  const expected=new Error('SYNTHETIC_ABORT');
  const h=fixture({behavior:async({callback,emit})=>{try {await callback();}catch(error){emit('abortTransaction');throw error;}}});
  await assert.rejects(h.run(async()=>{throw expected;}),e=>e===expected);
  await h.cleanup();assert.equal(h.deletions(),1);
});
test('promise fulfillment or local transaction state without acknowledgement is insufficient',async()=>{
  const h=fixture({behavior:async({callback,session})=>{const value=await callback();session.transaction={state:'TRANSACTION_COMMITTED'};return value;}});
  await assert.rejects(h.run(async()=>42),IntegrationSafetyError);await blocked(h);
});
for(const [name,options] of [
  ['another session',{lsid:{id:Buffer.alloc(16,2)}}],['write concern error',{reply:{ok:1,writeConcernError:{code:64}}}],
  ['error labels',{reply:{ok:1,errorLabels:['UnknownTransactionCommitResult']}}],['failed reply',{reply:{ok:0}}],
  ['uncompleted command',{complete:false}],['wrong command database',{databaseName:'fixture'}],
])test(name+' cannot establish a safe terminal outcome',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{await callback();emit('commitTransaction',options);}});
  await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);await blocked(h);
});
test('failed commit followed by successful retry never clears uncertainty',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{await callback();emit('commitTransaction',{ok:false});emit('commitTransaction');}});
  await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);await blocked(h);
});
test('unknown commit result followed by observed abort acknowledgement stays blocked',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{await callback();emit('abortTransaction');throw unknown();}});
  await assert.rejects(h.run(async()=>{}));await blocked(h);
});
test('a later confirmed transaction cannot reset an earlier uncertain transaction',async()=>{
  let first=true;
  const h=fixture({behavior:async({callback,emit})=>{await callback();if(first){first=false;throw failure('MongoNetworkError');}emit('commitTransaction');}});
  await assert.rejects(h.run(async()=>{}));await h.run(async()=>{});await blocked(h);
});
test('session closure failure or timeout after confirmed commit still blocks all deletion',async()=>{
  for(const finalize of [async()=>{throw failure();},()=>new Promise(()=>{})]) {
    const h=fixture({behavior:async({callback,emit})=>{await callback();emit('commitTransaction');},finalize,finalizeTimeoutMs:10});
    await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);await blocked(h);
  }
});
test('driver work remains tracked after a caller deadline; closure waits for actual settlement',async()=>{
  const gate=deferred(),h=fixture({timeoutMs:10,finalizeTimeoutMs:10,behavior:async({callback,emit})=>{await callback();await gate.promise;emit('commitTransaction');}});
  await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);
  assert.equal(h.ends(),0);assert.equal(h.sessions.size,1);assert.ok(h.life.pending()>0);
  await blocked(h);gate.resolve();await tick();assert.equal(h.ends(),1);assert.equal(h.sessions.size,0);
});
test('interruption while a transaction is active cannot be cured by a later commit',async()=>{
  const controller=new AbortController(),gate=deferred();
  const h=fixture({signal:controller.signal,behavior:async({callback,emit})=>{await callback();await gate.promise;emit('commitTransaction');}});
  const failed=assert.rejects(h.run(async()=>{}),IntegrationSafetyError);await tick();controller.abort();gate.resolve();await failed;await blocked(h);
});
test('an interrupted HTTP request latches uncertainty even if all promises have settled',async()=>{
  const h=fixture();await assert.rejects(h.life.track('request',async()=>{throw failure('AbortError');}));await blocked(h);
});
test('unmatched or out-of-order acknowledgement cannot confirm another terminal command',async()=>{
  const h=fixture({behavior:async({callback,emit,client})=>{
    await callback();const event=emit('commitTransaction',{complete:false});
    client.emit('commandSucceeded',{...event,requestId:event.requestId+1,reply:{ok:1}});
  }});
  await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);await blocked(h);
});
test('an acknowledgement from another transaction number cannot establish rollback',async()=>{
  const h=fixture({behavior:async({callback,emit,client,session})=>{
    await callback();emit('abortTransaction');
    client.emit('commandStarted',{commandName:'find',command:{lsid:session.id,txnNumber:2,autocommit:false}});
    emit('abortTransaction',{txnNumber:1});throw failure();
  }});
  await assert.rejects(h.run(async()=>{}));await blocked(h);
});
test('contradictory terminal acknowledgements are never accepted',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{await callback();emit('commitTransaction');emit('abortTransaction');throw failure();}});
  await assert.rejects(h.run(async()=>{}));await blocked(h);
});
test('nested network causes and numeric timeout codes remain uncertain after an abort acknowledgement',async()=>{
  for(const error of [new Error('Synthetic wrapper',{cause:failure('MongoNetworkError')}),Object.assign(failure('MongoServerError'),{code:50})]) {
    const h=fixture({behavior:async({callback,emit})=>{await callback();emit('abortTransaction');throw error;}});
    await assert.rejects(h.run(async()=>{}));await blocked(h);
  }
});
test('timed-out session finalization stays tracked until its actual promise settles',async()=>{
  const gate=deferred(),h=fixture({behavior:async({callback,emit})=>{await callback();emit('commitTransaction');},finalize:()=>gate.promise,finalizeTimeoutMs:10});
  await assert.rejects(h.run(async()=>{}),IntegrationSafetyError);assert.equal(h.sessions.size,1);assert.ok(h.life.pending()>0);
  await blocked(h);gate.resolve();await tick();assert.equal(h.sessions.size,0);assert.equal(h.life.pending(),0);
});

// Exact stale-proof regression: a prior ACK must not authorize cleanup for an
// unobserved later attempt, even when the driver returns an ordinary Error.
test('prior abort cannot survive missing-lsid retry events and ordinary rejection',async()=>{
  const h=fixture({behavior:async({callback,emit,client})=>{
    let rejected;
    try {await callback();}catch(error){rejected=error;emit('abortTransaction');}
    client.emit('commandStarted',{commandName:'find',command:{txnNumber:2,autocommit:false}});
    emit('abortTransaction',{lsid:null,txnNumber:2,ok:false});throw rejected;
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

test('new callback attempt cannot reuse a prior abort when its terminal number is stale',async()=>{
  const h=fixture({behavior:async({callback,emit,client,session})=>{
    try {await callback();}catch {emit('abortTransaction');}
    try {await callback();}catch(error){
      client.emit('commandStarted',{commandName:'find',command:{lsid:session.id,txnNumber:2,autocommit:false}});
      emit('abortTransaction',{txnNumber:1});throw error;
    }
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

test('new callback without observed commands or terminal proof cannot inherit an abort',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{
    try {await callback();}catch {emit('abortTransaction');}
    await callback();
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

for(const kind of ['commitTransaction','abortTransaction'])test('matched abort followed by conflicting '+kind+' blocks both cleanup and fixture deletion',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{
    try {await callback();}catch(error){emit('abortTransaction');emit(kind);throw error;}
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

for(const metadata of [{lsid:null},{lsid:{id:Buffer.alloc(2)}},{txnNumber:null}])test('incomplete terminal after valid ACK remains unsafe through session finalization '+JSON.stringify(Object.keys(metadata)),async()=>{
  let later;
  const h=fixture({behavior:async({callback,emit})=>{
    try {await callback();}catch(error){emit('abortTransaction');later=()=>emit('abortTransaction',metadata);throw error;}
  },finalize:async()=>later()});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

test('fresh complete abort evidence matches only the same callback rejection',async()=>{
  const expected=failure();
  const h=fixture({behavior:async({callback,emit})=>{try {await callback();}catch(error){emit('abortTransaction');throw error;}}});
  await assert.rejects(h.run(async()=>{throw expected;}),error=>error===expected);
  await h.cleanup();assert.equal(h.cleanups(),1);assert.equal(h.deletions(),1);
});

test('independently confirmed retry abort does not inherit the previous callback evidence',async()=>{
  const expected=failure();let count=0;
  const h=fixture({behavior:async({callback,emit})=>{
    try {await callback();}catch {emit('abortTransaction');}
    try {await callback();}catch(error){emit('abortTransaction',{txnNumber:2});throw error;}
  }});
  await assert.rejects(h.run(async()=>{if(++count===2)throw expected;throw failure();}),error=>error===expected);
  await h.cleanup();assert.equal(h.cleanups(),1);assert.equal(h.deletions(),1);
});

test('matched abort cannot authorize a different rejection from the driver',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{try {await callback();}catch {emit('abortTransaction');throw failure();}}});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

test('unmatched and duplicate completions after an ACK poison terminal evidence permanently',async()=>{
  for(const duplicate of [true,false]) {
    const h=fixture({behavior:async({callback,emit,client})=>{
      try {await callback();}catch(error){
        const event=emit('abortTransaction');
        client.emit('commandSucceeded',{...event,requestId:event.requestId+(duplicate?0:1),reply:{ok:1}});
        throw error;
      }
    }});
    await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
  }
});

test('incomplete retry evidence stays uncertain despite later complete apparently successful events',async()=>{
  const h=fixture({behavior:async({callback,emit})=>{
    try {await callback();}catch {emit('abortTransaction');}
    try {await callback();}catch(error){
      emit('abortTransaction',{lsid:null,txnNumber:2});
      emit('abortTransaction',{txnNumber:2});throw error;
    }
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});

test('completion with missing command identity after an ACK cannot preserve abort proof',async()=>{
  const h=fixture({behavior:async({callback,emit,client})=>{
    try {await callback();}catch(error){
      const event=emit('abortTransaction');
      client.emit('commandSucceeded',{...event,commandName:undefined,reply:{ok:1}});throw error;
    }
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});


test('same-session activity between terminal start and acknowledgement is out of order and refuses cleanup',async()=>{
  const h=fixture({behavior:async({callback,emit,client,session})=>{
    try {await callback();}catch(error){
      const event=emit('abortTransaction',{complete:false});
      client.emit('commandStarted',{commandName:'find',command:{lsid:session.id,txnNumber:1,autocommit:false}});
      client.emit('commandSucceeded',{...event,reply:{ok:1}});throw error;
    }
  }});
  await assert.rejects(h.run(async()=>{throw failure();}));await blocked(h);
});
