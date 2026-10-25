import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { User, Author, Book, Ticket, TicketMessage, InternalNote } from '../src/models/index.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createJwtService } from '../src/auth/jwt.js';
import { createBooksRouter } from '../src/books/routes.js';
import { createTicketsRouter } from '../src/tickets/routes.js';
import { createTicketServices } from '../src/tickets/service.js';
import { disabledAI } from '../src/ai/service.js';
import { readSource } from '../src/seed/source.js';
import { createLifecycle, bounded, trackRouter } from './lifecycle.js';
import { reviewCases } from './case-policy.js';
import { fixtureCapabilities } from './fixtures.js';
import { createTransactionRunner } from './transaction.js';
import { integrationConfig, assertIdentity, assertTopology, assertOwned, guardCollection, IntegrationSafetyError } from './guards.js';

const templates={User,Author,Book,Ticket,TicketMessage,InternalNote};
export function isolatedModels(connection,prefix,check,restrictions={}) {
  if(connection===mongoose.connection||!/^blit_[a-f0-9]{24}$/.test(prefix))throw new IntegrationSafetyError('An isolated connection and generated run namespace are required');
  return Object.fromEntries(Object.entries(templates).map(([name,template])=>{
    const collection=prefix+'_'+template.collection.name;
    const schema=template.schema.clone();schema.set('collection',collection);
    const model=connection.model(name,schema,collection);
    guardCollection(model.collection,()=>check(collection),restrictions);
    return [name,model];
  }));
}
// No module here imports server/app startup, application environment loading, or CLI scripts.
export async function openHarness(env,{createConnection=()=>mongoose.createConnection(),execArgv=process.execArgv,signal,drainTimeoutMs=5000}={}) {
  const config=integrationConfig(env,execArgv); // Must succeed before connection construction.
  await reviewCases();
  let source=null;
  if(config.sourcePath) {
    try {source=await readSource(config.sourcePath);}
    catch {throw new IntegrationSafetyError('Explicit source dataset is inaccessible or fails the pinned fingerprint/schema; no connection opened');}
  }
  const connection=createConnection(),owned=new Map(),sessions=new Set(),unregistered=new Set();
  if(connection===mongoose.connection||connection.readyState!==0)throw new IntegrationSafetyError('A new disconnected isolated connection is required');
  const prefix='blit_'+randomBytes(12).toString('hex'),marker='BookLeaf integration run '+prefix;
  let server,closing;
  const lifecycle=createLifecycle({signal,timeoutMs:drainTimeoutMs});
  const identity=()=>assertIdentity(connection,config);
  const interrupted=()=>lifecycle.admit();
  const collectionInfo=(name,exists=false)=>lifecycle.track('operation',async()=>{
    const cursor=connection.db.listCollections({name},{nameOnly:false});
    try {return await (exists?cursor.hasNext():cursor.next());}finally{await cursor.close?.();}
  });
  async function check(name) {
    interrupted();identity();
    const record=owned.get(name);
    if(!record)throw new IntegrationSafetyError('Collection was not created by this run; operation refused');
    const info=await collectionInfo(name);
    interrupted();identity();assertOwned(info,record);
  }
  let models;
  async function clearOwned() {
    // Only UUID-registered entries created by this run. A partial create whose
    // UUID could not be established is never adopted or deleted.
    for(const model of Object.values(models??{})) {
      if(!owned.has(model.collection.name))continue;
      await check(model.collection.name);await model.deleteMany({});
    }
  }
  const clearRecords=()=>lifecycle.maintain(clearOwned);
  const transaction=createTransactionRunner({connection,lifecycle,sessions,signal,check:()=>{interrupted();identity();},finalizeTimeoutMs:drainTimeoutMs});
  function close() {
    if(closing)return closing;
    closing=(async()=>{
      let failed=false;
      // Stop new requests, but don't infer handler completion from socket closure.
      if(server){server.close();server.closeAllConnections();}
      try {
        await lifecycle.maintain(async()=>{
          if(sessions.size)throw new IntegrationSafetyError('Active integration sessions remain; cleanup refused');
          await clearOwned();
        },{terminal:true});
      } catch {failed=true;lifecycle.fail();}
      if(unregistered.size)failed=true;
      // On drain failure no cleanup is attempted. Closing is bounded and may
      // abort pending operations; it is never reported as successful cleanup.
      try {await bounded(()=>connection.close(true),drainTimeoutMs);}catch{failed=true;}
      if(failed)throw new IntegrationSafetyError('Integration cleanup incomplete; pending work or connection outcome requires private inspection');
    })();
    return closing;
  }

  try {
    interrupted();
    await bounded(()=>lifecycle.track('connection',()=>connection.openUri(config.uri,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,socketTimeoutMS:10000,readPreference:'primary',monitorCommands:true})),10000);
    identity();assertTopology(await lifecycle.track('operation',()=>connection.db.command({hello:1})));
    models=isolatedModels(connection,prefix,check,{track:lifecycle.track,sessionAllowed:active=>sessions.has(active)&&!active.hasEnded});
    for(const model of Object.values(models)) {
      interrupted();identity();
      const name=model.collection.name;
      if(await collectionInfo(name,true))throw new IntegrationSafetyError('Run collection already exists; refusing adoption or cleanup');
      identity();
      unregistered.add(name);
      await lifecycle.track('operation',()=>connection.db.createCollection(name,{validator:{$jsonSchema:{bsonType:'object',description:marker}},validationLevel:'strict'}));
      const info=await collectionInfo(name);
      if(!info?.info?.uuid)throw new IntegrationSafetyError('Collection ownership could not be established');
      owned.set(name,{name,marker,uuid:info.info.uuid.toString('hex')});
      unregistered.delete(name);
      await check(name);await model.createIndexes(); // Isolated clones only, never the production CLI.
    }
    // Exercise an actual server transaction, not merely session object existence.
    await transaction(async session=>{await models.Ticket.findOne({}).session(session).lean();});
    const services=createTicketServices({models,transaction});
    const auth=createAuthMiddleware(models),jwt=createJwtService({jwtSecret:randomBytes(32)});
    const app=express();app.disable('x-powered-by');app.use(express.json({limit:'100kb'}));
    app.locals.jwtService=jwt;app.locals.aiService=disabledAI;
    app.use('/api',trackRouter(createBooksRouter({models,auth}),lifecycle));app.use('/api',trackRouter(createTicketsRouter({models,auth,services}),lifecycle));
    app.use((_req,res)=>res.status(404).json({error:'Route not found'}));
    app.use((_error,_req,res,_next)=>res.status(500).json({error:'Integration request failed (details suppressed)'}));
    server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const request=(path,{user,body,method=body?'POST':'GET',revision}={})=>lifecycle.track('request',async()=>{
      if(!/^\/api\/(?:me|admin)\/(?:books|tickets)(?:[/?]|$)/.test(path))throw new IntegrationSafetyError('Only local product routes are allowed');
      identity();
      const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{...(user?{Authorization:'Bearer '+jwt.sign({userId:user._id,tokenVersion:user.tokenVersion})}:{}),...(body?{'Content-Type':'application/json'}:{}),...(revision!==undefined?{'If-Match':JSON.stringify(String(revision))}:{})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,body:await response.json()};
    });
    const capabilities=fixtureCapabilities({models,services,transaction,track:lifecycle.track,request,source});
    return Object.freeze({clearRecords,close,runCase:work=>lifecycle.track('case',()=>work(capabilities))});
  } catch(error) {
    try {await close();}catch{throw new IntegrationSafetyError('Integration setup/cleanup failed; inspect the approved test namespace privately');}
    if(error instanceof IntegrationSafetyError)throw error;
    throw new IntegrationSafetyError('Integration setup failed (connection/authentication/transaction/index details suppressed)');
  }
}
