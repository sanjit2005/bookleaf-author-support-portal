import mongoose from 'mongoose';

// Every message is constant: never interpolate URI, driver errors or supplied options.
export class IntegrationSafetyError extends Error {}
const refuse=message=>{throw new IntegrationSafetyError(message);};
export function integrationConfig(env,execArgv=[]) {
  if(env.NODE_ENV!=='test'||env.RUN_DB_INTEGRATION_TESTS!=='1')refuse('Integration tests require NODE_ENV=test and RUN_DB_INTEGRATION_TESTS=1');
  if(env.NODE_OPTIONS?.trim()||execArgv.some(value=>/^--(?:env-file|import|require)|^-r/.test(value)))refuse('Integration tests require a clean Node process without environment files or preloads');
  const database=env.TEST_DATABASE_NAME;
  if(typeof database!=='string'||!/^bookleaf_test_[a-z0-9]{8,24}$/.test(database)||/prod|demo|support|admin|local|config/.test(database))refuse('TEST_DATABASE_NAME must be an explicitly approved bookleaf_test_ name with an 8-24 character lowercase alphanumeric suffix');
  const uri=env.TEST_MONGODB_URI;
  if(typeof uri!=='string'||uri.length>4096||/[\s<>#\x00-\x1f]/.test(uri))refuse('A valid authenticated TEST_MONGODB_URI is required; no application URI fallback is allowed');
  const match=/^mongodb(\+srv)?:\/\/([^/?#]+)\/([^/?#]+)(?:\?([^#]*))?$/.exec(uri);
  if(!match||match[3]!==database)refuse('The URI must name exactly the approved test database, without encoded or ambiguous names');
  const params=new URLSearchParams(match[4]??''),seen=new Set();
  for(const [key,value] of params) {
    if(seen.has(key.toLowerCase()))refuse('Duplicate integration URI options are forbidden');
    seen.add(key.toLowerCase());
    if(!['authSource','replicaSet','tls','retryWrites','w'].includes(key))refuse('Unsupported integration URI option');
    if(key==='authSource'&&![database,'admin'].includes(value)||key==='replicaSet'&&!/^[a-zA-Z0-9_-]{1,64}$/.test(value)||key==='tls'&&!['true','false'].includes(value)||key==='retryWrites'&&value!=='true'||key==='w'&&value!=='majority')refuse('Unsafe integration URI option');
  }
  let options;
  try {options=new mongoose.mongo.MongoClient(uri).options;}
  catch {refuse('Invalid MongoDB URI configuration (details suppressed)');}
  if(options.dbName!==database||!options.credentials?.username||!options.credentials?.password||/[\x00-\x1f\x7f]/.test(options.credentials.username+options.credentials.password))refuse('Integration URI requires explicit username/password authentication and the approved database');
  const hosts=options.srvHost?[options.srvHost]:options.hosts.map(host=>host.toString());
  const approved=typeof env.TEST_MONGODB_HOSTS==='string'?env.TEST_MONGODB_HOSTS.split(','):[];
  if(!approved.length||approved.some(host=>host!==host.trim()||! /^(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/.test(host))||new Set(approved).size!==approved.length||hosts.some(host=>!approved.includes(host)))refuse('Every test URI host must match the separately approved TEST_MONGODB_HOSTS list');
  if(options.tls!==true&&hosts.some(host=>! /^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(host)))refuse('Remote integration connections require TLS with normal certificate verification');
  return Object.freeze({uri,database,sourcePath:env.TEST_SOURCE_DATA_PATH||null});
}
export function assertIdentity(connection,config) {
  if(connection===mongoose.connection||connection.readyState!==1||connection.name!==config.database||connection.db?.databaseName!==config.database||connection.getClient?.()?.options?.dbName!==config.database)refuse('Integration database identity mismatch; operation refused');
}
export function assertTopology(hello) {
  if(!hello||!(typeof hello.setName==='string'&&hello.setName.length||hello.msg==='isdbgrid')||!Number.isInteger(hello.logicalSessionTimeoutMinutes)||hello.logicalSessionTimeoutMinutes<1||!Number.isInteger(hello.maxWireVersion)||hello.maxWireVersion<(hello.msg==='isdbgrid'?8:7))refuse('Transactions require a session-capable replica set or suitable sharded deployment; standalone MongoDB is unsupported');
}
export function assertOwned(info,owned) {
  if(!info||info.name!==owned.name||info.options?.validator?.$jsonSchema?.description!==owned.marker||!info.info?.uuid||info.info.uuid.toString('hex')!==owned.uuid)refuse('Run-owned collection marker or identity mismatch; write/cleanup refused');
}
export function containsWriteStage(value) {
  return !!value&&typeof value==='object'&&Object.entries(value).some(([key,nested])=>['$out','$merge'].includes(key)||containsWriteStage(nested));
}
// Deliberate inventory: only save(), private cleanup and private index setup write.
export const WRITE_METHODS=Object.freeze(['insertOne','updateOne','deleteMany','createIndex']);
const PROMISE_READS=['findOne'];
const CURSOR_READS=['find','listIndexes'];
const guarded=new WeakSet();
function rejectOverrides(value,seen=new Set()) {
  if(value==null||typeof value!=='object'||value._bsontype||value instanceof Date||Buffer.isBuffer(value))return;
  if(seen.has(value))refuse('Cyclic integration arguments are forbidden');seen.add(value);
  for(const key of Reflect.ownKeys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||descriptor.get||descriptor.set)refuse('Accessor or symbolic integration options are forbidden');
    if(['dbname','authdb','__proto__','constructor','prototype'].includes(key.toLowerCase()))refuse('Database namespace overrides are forbidden');
    rejectOverrides(descriptor.value,seen);
  }
  seen.delete(value);
}
function copy(value) {
  if(value===undefined)return value;
  return mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({value})).value;
}
export function snapshotArguments(args,sessionAllowed=()=>false) {
  return args.map(value=>{
    if(value==null||typeof value!=='object'){if(typeof value==='function')refuse('Callbacks are forbidden');return value;}
    for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))if(descriptor.get||descriptor.set)refuse('Accessor integration arguments are forbidden');
    const session=Object.hasOwn(value,'session')?value.session:undefined;
    // Sessions are capabilities owned by the harness, never traversed/copied as data.
    const data=session===undefined?value:Object.fromEntries(Object.entries(value).filter(([key])=>key!=='session'));
    if(session!==undefined&&!sessionAllowed(session))refuse('An integration-owned session is required');
    rejectOverrides(data);const result=copy(data);rejectOverrides(result);
    if(session!==undefined)result.session=session;
    return result;
  });
}
function view(methods) {
  const entries=Object.entries(methods).map(([key,value])=>[key,typeof value==='function'?new Proxy(value,{
    get(){refuse('Integration capability introspection is forbidden');},getPrototypeOf:()=>null,
  }):value]);
  const result=Object.freeze(Object.assign(Object.create(null),Object.fromEntries(entries)));
  return new Proxy(result,{get(target,key){if(key==='then')return undefined;if(Object.hasOwn(target,key))return target[key];refuse('Unsupported integration capability');}});
}
export const capabilityView=view;

// Models/native collections are private to the harness. This boundary also checks
// direct Model.collection calls. Unknown driver methods are denied, not inherited.
export function guardCollection(collection,check,{track=(_kind,work)=>work(),sessionAllowed=()=>false}={}) {
  if(guarded.has(collection))return;guarded.add(collection);
  const originals=new Map();
  for(let prototype=mongoose.mongo.Collection.prototype;prototype&&prototype!==Object.prototype;prototype=Object.getPrototypeOf(prototype)) {
    for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype)))if(name!=='constructor'&&typeof descriptor.value==='function')originals.set(name,collection[name]);
  }
  for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(collection)))if(typeof descriptor.value==='function')originals.set(name,descriptor.value);
  for(let prototype=Object.getPrototypeOf(collection);prototype&&prototype!==Object.prototype&&prototype.constructor===Object;prototype=Object.getPrototypeOf(prototype)) {
    for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype)))if(typeof descriptor.value==='function')originals.set(name,collection[name]);
  }
  const execute=(method,args)=>track('operation',async()=>{await check();return originals.get(method).apply(collection,args);});
  for(const method of [...WRITE_METHODS,...PROMISE_READS]) {
    if(typeof originals.get(method)!=='function')continue;
    collection[method]=function(...args){const snapshot=snapshotArguments(args,sessionAllowed);return execute(method,snapshot);};
  }
  const cursor=(method,args,validate=()=>{})=>view({toArray:()=>track('operation',async()=>{
    validate();await check();validate();
    const native=originals.get(method).apply(collection,args);
    try {return await native.toArray();}finally{await native.close?.();}
  })});
  for(const method of CURSOR_READS)if(typeof originals.get(method)==='function')collection[method]=function(...args){return cursor(method,snapshotArguments(args,sessionAllowed));};
  if(typeof originals.get('aggregate')==='function')collection.aggregate=function(pipeline,options={}) {
    // No native cursor is constructed until execution. Only the application's
    // actual read-only option is supported; out/cursor/session/etc fail closed.
    if(!options||typeof options!=='object'||Array.isArray(options))refuse('Unsupported aggregation options');
    rejectOverrides(options);
    if(Object.keys(options).some(key=>key!=='allowDiskUse')||options.allowDiskUse!==undefined&&typeof options.allowDiskUse!=='boolean')refuse('Unsupported aggregation options');
    if(!Array.isArray(pipeline)||containsWriteStage(pipeline))refuse('Writing aggregation stages are forbidden');
    const [snapshot,safeOptions]=snapshotArguments([pipeline,options]);
    const validate=()=>{if(containsWriteStage(snapshot))refuse('Writing aggregation stages are forbidden');};
    return cursor('aggregate',[snapshot,safeOptions],validate);
  };
  if(typeof originals.get('countDocuments')==='function')collection.countDocuments=function(filter={},options={}) {
    const [safeFilter,safeOptions]=snapshotArguments([filter,options],sessionAllowed);
    if(Object.keys(safeOptions).some(key=>!['session','maxTimeMS'].includes(key)))refuse('Unsupported count options');
    return execute('countDocuments',[safeFilter,safeOptions]);
  };
  const allowed=new Set([...WRITE_METHODS,...PROMISE_READS,...CURSOR_READS,'aggregate','countDocuments']);
  for(const method of originals.keys())if(!allowed.has(method))collection[method]=()=>refuse('Unsupported integration database method');
  // These must be denied even if a fake/driver version omits the method.
  for(const method of ['drop','dropIndex','dropIndexes','rename','createSearchIndex','createSearchIndexes','updateSearchIndex','dropSearchIndex','initializeOrderedBulkOp','initializeUnorderedBulkOp','bulkWrite','insertMany','updateMany','replaceOne','deleteOne','findOneAndUpdate','findOneAndReplace','findOneAndDelete'])collection[method]=()=>refuse('Unsupported integration database method');
}
