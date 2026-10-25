import { AsyncLocalStorage } from 'node:async_hooks';
import { IntegrationSafetyError } from './guards.js';

export async function bounded(work,timeoutMs) {
  let timer;
  try {return await Promise.race([Promise.resolve().then(work),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new IntegrationSafetyError('Outstanding integration work could not be drained; cleanup refused')),timeoutMs);})]);}
  finally {clearTimeout(timer);}
}

export function ambiguousTransactionError(error,seen=new Set()) {
  if(!error||seen.has(error))return false;seen.add(error);
  return /network|timeout|serverselection|aborterror|interrupted/i.test(error?.name??'')
    || ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE','ABORT_ERR',50,64,89,91,189,262,9001,11600,11601].includes(error?.code)
    || error?.hasErrorLabel?.('UnknownTransactionCommitResult')===true
    || ambiguousTransactionError(error.cause,seen);
}

// Socket completion is not handler completion. Track the returned handler/transaction
// promises, including nested operations, until they actually settle.
export function createLifecycle({signal,timeoutMs=5000}={}) {
  const context=new AsyncLocalStorage(),active=new Set(),waiters=new Set(),maintenance=Symbol('maintenance');
  let state='running',uncertain=false;
  const onAbort=()=>{if([...active].some(token=>token.kind.startsWith('transaction')))uncertain=true;};
  signal?.addEventListener('abort',onAbort,{once:true});
  function admit() {
    const scope=context.getStore();
    if((scope===maintenance||scope?.maintenance===maintenance)&&state==='maintenance')return;
    if(scope&&!active.has(scope))throw new IntegrationSafetyError('Detached integration work is forbidden');
    if(signal?.aborted||state==='failed'||state==='closed'||state==='maintenance')throw new IntegrationSafetyError('Integration work admission refused');
    if(state!=='running'&&!active.has(context.getStore()))throw new IntegrationSafetyError('Integration work is draining');
  }
  async function track(kind,work,{confirmedAbort=()=>false}={}) {
    const scope=context.getStore();
    // Resource release may finish after interruption, but gains no maintenance or
    // fixture-operation privilege. It must descend from an admitted transaction.
    const releasing=kind==='transaction-finalization'&&active.has(scope)&&scope.kind.startsWith('transaction');
    if(!releasing)admit();
    const token={kind,maintenance:scope===maintenance||scope?.maintenance===maintenance?maintenance:undefined};active.add(token);
    try {return await context.run(token,work);}
    catch(error) {
      // An uncertain network/commit outcome must not be followed by destructive
      // fixture cleanup. Known server rejections used by the cases are definitive.
      if(kind==='operation'&&!(error instanceof IntegrationSafetyError)&&![11000,112].includes(error?.code))uncertain=true;
      // Only the private transaction runner can supply acknowledgement evidence.
      // By default ALL transaction failures, including ordinary Error objects,
      // are unconfirmed. A resolved endSession/abort promise is never evidence.
      if(kind.startsWith('transaction')&&(ambiguousTransactionError(error)||signal?.aborted||!confirmedAbort(error)))uncertain=true;
      if(kind==='request'&&ambiguousTransactionError(error))uncertain=true;
      if(error?.hasErrorLabel?.('UnknownTransactionCommitResult'))uncertain=true;
      throw error;
    } finally {active.delete(token);if(!active.size)for(const resolve of waiters)resolve();}
  }
  async function maintain(work,{terminal=false}={}) {
    if(state!=='running')throw new IntegrationSafetyError('Integration maintenance is unavailable');
    state='draining';
    try {
      await bounded(async()=>{if(active.size)await new Promise(resolve=>waiters.add(resolve));},timeoutMs);
      if(active.size||uncertain)throw new IntegrationSafetyError('Integration outcome is uncertain; cleanup refused');
      state='maintenance';
      await bounded(()=>context.run(maintenance,work),timeoutMs);
      if(active.size)throw new IntegrationSafetyError('Maintenance left outstanding work; cleanup is incomplete');
      state=terminal?'closed':'running';
      if(terminal)signal?.removeEventListener('abort',onAbort);
    } catch(error) {state='failed';throw error;}
    finally {waiters.clear();}
  }
  return Object.freeze({track,maintain,admit,markUncertain:()=>{uncertain=true;},fail:()=>{state='failed';signal?.removeEventListener('abort',onAbort);},pending:()=>active.size});
}

export function trackRouter(router,lifecycle) {
  for(const layer of router.stack) {
    if(layer.route) {trackRouter(layer.route,lifecycle);continue;}
    const handle=layer.handle;
    if(typeof handle!=='function')continue;
    layer.handle=handle.length===4
      ? function(error,req,res,next){return lifecycle.track('handler',()=>handle(error,req,res,next)).catch(next);}
      : function(req,res,next){return lifecycle.track('handler',()=>handle(req,res,next)).catch(next);};
  }
  return router;
}
