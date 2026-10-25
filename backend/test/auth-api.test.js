import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User } from '../src/models/index.js';
import { createJwtService, JWT_SETTINGS } from '../src/auth/jwt.js';
import { createAuthRouter, createLoginLimiter } from '../src/auth/routes.js';
import { authenticate, requireRole } from '../src/auth/middleware.js';
import { publicUserDTO } from '../src/db/serialization.js';

test('safe user DTO excludes deliberately malicious nested and internal fields',()=>{
 const dto=publicUserDTO({_id:new mongoose.Types.ObjectId(),email:'test@example.com',role:'author',passwordHash:'PRIVATE',tokenVersion:9,accountStatus:'active',internalNotes:['PRIVATE'],credentials:{secret:'PRIVATE'},author:{passwordHash:'PRIVATE'}});
 assert.deepEqual(Object.keys(dto).sort(),['_id','email','role']);assert.equal(JSON.stringify(dto).includes('PRIVATE'),false);
 assert.throws(()=>publicUserDTO({_id:new mongoose.Types.ObjectId(),email:{passwordHash:'PRIVATE'},role:'author'}),TypeError);
});

test('authentication HTTP routes with isolated model mocks and no database',async t=>{
 const key=randomBytes(32),service=createJwtService({jwtSecret:key});
 const hash=await bcrypt.hash('test-password-only',10);
 const authorId=new mongoose.Types.ObjectId(),adminId=new mongoose.Types.ObjectId();
 const records=new Map([
  [authorId.toHexString(),{_id:authorId,email:'author@example.com',role:'author',accountStatus:'active',passwordHash:hash,tokenVersion:0,__v:0}],
  [adminId.toHexString(),{_id:adminId,email:'admin@example.com',role:'admin',accountStatus:'active',passwordHash:hash,tokenVersion:0,__v:0}],
 ]);
 let reads=0,saves=0,conflictOnce=false,dbError=false;
 const query=lookup=>({select:async selection=>{
   reads++;if(dbError)throw new Error('PRIVATE_DATABASE_ERROR');
   const record=lookup();if(!record)return null;
   const selectedHash=selection.includes('+passwordHash');
   const value={...record};if(!selectedHash)delete value.passwordHash;
   return User.hydrate(value,selectedHash?undefined:{passwordHash:0});
 }});
 t.mock.method(User,'findOne',filter=>query(()=>[...records.values()].find(u=>u.email===filter.email)));
 t.mock.method(User,'findById',value=>query(()=>records.get(String(value))));
 t.mock.method(User.prototype,'save',async function(){
   await this.validate();saves++;
   const stored=records.get(String(this._id));
   if(conflictOnce){conflictOnce=false;stored.tokenVersion++;stored.__v++;const error=new Error('conflict');error.name='VersionError';throw error;}
   assert.equal(this.__v,stored.__v);
   stored.tokenVersion=this.tokenVersion;stored.__v++;return this;
 });
 const app=express();app.locals.jwtService=service;app.use(express.json());
 app.use('/api',createAuthRouter({loginLimiter:createLoginLimiter({limit:100})}));
 app.get('/only-admin',authenticate,requireRole('admin'),(_req,res)=>res.json({ok:true}));
 app.get('/only-author',authenticate,requireRole('author'),(_req,res)=>res.json({ok:true}));
 app.use((error,_req,res,_next)=>res.status(500).json({error:'Internal server error'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,{token,body,method=body?'POST':'GET'}={})=>{
   const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   return {status:response.status,body:await response.json(),headers:response.headers};
 };
 let token;
 await t.test('valid normalized login returns only safe identity and correct token',async()=>{
   const result=await request('/api/auth/login',{body:{email:' AUTHOR@Example.com ',password:'test-password-only'}});
   assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
   assert.deepEqual(result.body.user,{_id:authorId.toHexString(),email:'author@example.com',role:'author'});
   assert.equal(result.body.expiresIn,900);assert.equal(result.body.tokenType,'Bearer');
   token=result.body.accessToken;assert.deepEqual(service.verify(token),{userId:authorId.toHexString(),tokenVersion:0});
   assert.ok(!JSON.stringify(result.body.user).includes('password'));assert.equal(result.body.user.tokenVersion,undefined);
 });
 await t.test('legacy short and non-null control-character passwords still log in exactly',async()=>{
   const user=records.get(String(authorId));
   try {
     for(const legacy of ['x','old\tpass']){
       user.passwordHash=await bcrypt.hash(legacy,10);
       const result=await request('/api/auth/login',{body:{email:'author@example.com',password:legacy}});
       assert.equal(result.status,200);
     }
   } finally {user.passwordHash=hash;}
 });
 await t.test('wrong passwords, unknown identities and inactive accounts use identical generic errors',async()=>{
   const attempts=[
    {email:'author@example.com',password:'wrong'},
    {email:'missing@example.com',password:'test-password-only'},
    {email:{$ne:null},password:'test-password-only'},
    {email:'bad',password:'test-password-only'},
    {email:'author@example.com',password:'a'.repeat(73)},
    {email:'author@example.com',password:'test-password-only',role:'admin'},
   ];
   let generic;
   for(const body of attempts){const result=await request('/api/auth/login',{body});assert.equal(result.status,401);generic??=result.body;assert.deepEqual(result.body,generic);}
   for(const status of ['pending','disabled']){
     records.get(String(authorId)).accountStatus=status;
     const result=await request('/api/auth/login',{body:{email:'author@example.com',password:'test-password-only'}});
     assert.equal(result.status,401);assert.deepEqual(result.body,generic);
   }
   records.get(String(authorId)).accountStatus='active';
   records.get(String(authorId)).passwordHash=null;
   const noHash=await request('/api/auth/login',{body:{email:'author@example.com',password:'test-password-only'}});
   assert.equal(noHash.status,401);assert.deepEqual(noHash.body,generic);
   records.get(String(authorId)).passwordHash=hash;
 });
 await t.test('missing/malformed/expired/invalid tokens fail and invalid signatures never query users',async()=>{
   const now=Math.floor(Date.now()/1000);
   const expired=jwt.sign({tokenVersion:0,iat:now-1000,exp:now-100,sub:String(authorId),iss:JWT_SETTINGS.issuer,aud:JWT_SETTINGS.audience},key,{algorithm:'HS256'});
   const before=reads;
   for(const value of [undefined,'garbage',token+'bad',expired]){
     const result=await request('/api/me',{token:value});assert.equal(result.status,401);
   }
   assert.equal(reads,before);
   const malformed=await fetch(base+'/api/me',{headers:{Authorization:'Basic abc'}});assert.equal(malformed.status,401);
 });
 await t.test('current user DTO and role restrictions use database roles, not client input',async()=>{
   const me=await request('/api/me?role=admin',{token});assert.equal(me.status,200);
   assert.deepEqual(Object.keys(me.body.user).sort(),['_id','email','role']);
   assert.equal((await request('/only-admin',{token})).status,403);
   assert.equal((await request('/only-author',{token})).status,200);
   const adminToken=service.sign({userId:adminId,tokenVersion:0});
   assert.equal((await request('/only-admin',{token:adminToken})).status,200);
   assert.equal((await request('/only-author',{token:adminToken})).status,403);
   records.get(String(adminId)).role='author';
   assert.equal((await request('/only-admin',{token:adminToken})).status,403);
   records.get(String(adminId)).role='admin';
 });
 await t.test('deleted, disabled and revoked accounts are rejected on each request',async()=>{
   records.get(String(authorId)).accountStatus='disabled';assert.equal((await request('/api/me',{token})).status,401);
   records.get(String(authorId)).accountStatus='active';records.get(String(authorId)).tokenVersion=1;assert.equal((await request('/api/me',{token})).status,401);
   records.get(String(authorId)).tokenVersion=0;
   const absent=service.sign({userId:new mongoose.Types.ObjectId(),tokenVersion:0});assert.equal((await request('/api/me',{token:absent})).status,401);
 });
 await t.test('logout invalidates every previously issued token for that user, not other accounts',async()=>{
   const secondToken=service.sign({userId:authorId,tokenVersion:0});
   const response=await request('/api/auth/logout',{token,method:'POST'});
   assert.equal(response.status,200);assert.match(response.body.message,/All existing/);assert.equal(records.get(String(authorId)).tokenVersion,1);assert.equal(saves,1);
   for(const old of [token,secondToken])assert.equal((await request('/api/me',{token:old})).status,401);
   const adminToken=service.sign({userId:adminId,tokenVersion:0});assert.equal((await request('/api/me',{token:adminToken})).status,200);
   assert.equal((await request('/api/auth/logout',{method:'POST'})).status,401);
 });
 await t.test('logout retries optimistic concurrency without overwriting a newer token version',async()=>{
   conflictOnce=true;const current=service.sign({userId:authorId,tokenVersion:1});
   const result=await request('/api/auth/logout',{token:current,method:'POST'});assert.equal(result.status,200);
   assert.equal(records.get(String(authorId)).tokenVersion,3);assert.equal((await request('/api/me',{token:current})).status,401);
 });
 await t.test('database failures are sanitized, not exposed as credential details',async()=>{
   dbError=true;const result=await request('/api/me',{token:service.sign({userId:authorId,tokenVersion:3})});
   assert.equal(result.status,500);assert.deepEqual(result.body,{error:'Internal server error'});dbError=false;
 });
 await t.test('login database failures return sanitized 500 without resetting HTTP or becoming 401',async()=>{
   dbError=true;
   try {
     const result=await request('/api/auth/login',{body:{email:'author@example.com',password:'synthetic-invalid-login'}});
     assert.equal(result.status,500);assert.deepEqual(result.body,{error:'Internal server error'});
   } finally {dbError=false;}
   const healthy=await request('/api/auth/login',{body:{email:'author@example.com',password:'synthetic-invalid-login'}});
   assert.equal(healthy.status,401);
 });
 await t.test('production without proxy trust still authenticates through bcrypt and returns only the safe identity',async()=>{
   app.locals.httpSecurity={production:true,trustProxy:false};
   try {
     const result=await request('/api/auth/login',{body:{email:' AUTHOR@Example.com ',password:'test-password-only'}});
     assert.equal(result.status,200);assert.deepEqual(result.body.user,{_id:authorId.toHexString(),email:'author@example.com',role:'author'});
     assert.deepEqual(service.verify(result.body.accessToken),{userId:authorId.toHexString(),tokenVersion:3});
     const denied=await request('/api/auth/login',{body:{email:'author@example.com',password:'synthetic-invalid-login'}});
     assert.equal(denied.status,401);assert.deepEqual(denied.body,{error:'Authentication required or invalid credentials'});
   } finally {delete app.locals.httpSecurity;}
 });
});

test('login rate limiting returns JSON 429 before credential/database processing',async t=>{
 const app=express();app.use(express.json());app.use('/api',createAuthRouter({loginLimiter:createLoginLimiter({limit:2})}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 for(let i=0;i<3;i++){
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   assert.equal(response.status,i===2?429:401);
   if(i===2){assert.ok(response.headers.get('retry-after'));assert.deepEqual(await response.json(),{error:'Too many login attempts; try again later'});}
 }
});

test('login admission tracks actual work after client closure and recovers after failure without a shared lockout',async t=>{
 let rejectRead;const pending=new Promise((_resolve,reject)=>{rejectRead=reject;});let pendingRead=true,limiterCalls=0,reads=0;
 t.mock.method(User,'findOne',()=>({select:()=>{reads++;return pendingRead?pending:null;}}));
 const router=createAuthRouter({maxConcurrentLogins:1,loginLimiter:(_req,_res,next)=>{limiterCalls++;next();}});
 const handler=router.stack.find(layer=>layer.route?.path==='/auth/login').route.stack[0].handle;
 const req=()=>({body:{email:'synthetic@example.test',password:'synthetic-test-password'},app:{locals:{jwtService:{}}}});
 const res=()=>{const value=new EventEmitter();value.set=()=>value;value.status=code=>{value.code=code;return value;};value.json=body=>{value.body=body;value.emit('finish');return value;};return value;};
 const first=res();handler(req(),first,error=>{assert.ok(error);first.status(500).json({error:'Internal server error'});});
 assert.equal(reads,1);first.destroyed=true;first.emit('close');
 const blocked=res();handler(req(),blocked,()=>assert.fail('Overload must not reach authentication'));
 assert.equal(blocked.code,503);assert.deepEqual(blocked.body,{error:'Login is busy; try again shortly'});assert.equal(reads,1);assert.equal(limiterCalls,1);
 pendingRead=false;rejectRead(new Error('Synthetic database failure'));await new Promise(setImmediate);
 const recovered=res(),finished=once(recovered,'finish');handler(req(),recovered,error=>assert.fail(error.message));await finished;
 assert.equal(recovered.code,401);assert.equal(reads,2);assert.equal(limiterCalls,2);
});
