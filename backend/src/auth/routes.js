import { Router } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { rateLimit } from 'express-rate-limit';
import { User } from '../models/index.js';
import { BCRYPT_COST, validPasswordHash, validPasswordInput } from './password-policy.js';
import { normalizeEmail } from './email.js';
import { authenticate, unauthorized, jwtFor } from './middleware.js';
import { publicUserDTO } from '../db/serialization.js';
import { JWT_SETTINGS } from './jwt.js';

// Lazily generated, process-local comparison target; never a real account credential.
let dummyHash;
function fallbackHash() {return dummyHash ??= bcrypt.hash(randomBytes(32).toString('hex'),BCRYPT_COST);}
function credentials(body) {
  if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['email','password'].includes(k))||typeof body.email!=='string'||typeof body.password!=='string') return null;
  const email=normalizeEmail(body.email);
  if(!email||!validPasswordInput(body.password)) return null;
  return {email,password:body.password};
}
export function createLoginLimiter(options={}) {
  const settings={windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,
    message:{error:'Too many login attempts; try again later'},...options};
  const ipLimiter=rateLimit(settings);
  const key=randomBytes(32);
  const targetLimiter=rateLimit({...settings,keyGenerator:req=>{
    // An untrusted login target is a throttle key, NEVER an authenticated identity.
    // Normalize exactly as login does; do not retain email addresses in the store.
    // Invalid requests share their own bucket, not a real account's allowance.
    const target=credentials(req.body)?.email??'invalid-login-input';
    return createHmac('sha256',key).update(target).digest('hex');
  }});
  return (req,res,next)=>{
    const config=req.app.locals.httpSecurity;
    // A shared ingress address cannot identify a client. Do not create a shared
    // 15-minute login ban, nor use spoofable X-Forwarded-For/identity headers.
    return (config?.production&&config.trustProxy===false?targetLimiter:ipLimiter)(req,res,next);
  };
}
export function createAuthRouter({loginLimiter=createLoginLimiter(),maxConcurrentLogins=4}={}) {
  if(!Number.isSafeInteger(maxConcurrentLogins)||maxConcurrentLogins<1)throw new Error('Invalid login concurrency limit');
  let activeLogins=0;
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const login=async(req,res)=>{
    const input=credentials(req.body);
    if(!input) return unauthorized(res);
    const service=jwtFor(req);
    const user=await User.findOne({email:input.email}).select('+passwordHash email role accountStatus tokenVersion');
    const usable=Boolean(user&&validPasswordHash(user.passwordHash));
    const matched=await bcrypt.compare(input.password,usable?user.passwordHash:await fallbackHash());
    if(!matched||!usable||user.accountStatus!=='active'||!['author','admin'].includes(user.role)) return unauthorized(res);
    const accessToken=service.sign({userId:user._id,tokenVersion:user.tokenVersion});
    res.json({accessToken,tokenType:'Bearer',expiresIn:JWT_SETTINGS.expiresIn,user:publicUserDTO(user)});
  };
  router.post('/auth/login',(req,res,next)=>{
    // Bound actual limiter/database/bcrypt work without a long-lived global ban.
    // A disconnected client does not release a slot while login work continues.
    if(activeLogins>=maxConcurrentLogins)return res.set('Retry-After','1').status(503).json({error:'Login is busy; try again shortly'});
    activeLogins++;
    let executing=false,released=false;
    const release=()=>{
      if(released)return;
      released=true;activeLogins--;res.off('finish',finished);res.off('close',finished);
    };
    const finished=()=>{if(!executing)release();};
    res.once('finish',finished);res.once('close',finished);
    Promise.resolve(loginLimiter(req,res,error=>{
      if(error){release();next(error);return;}
      if(released||res.destroyed||res.writableEnded){release();return;}
      executing=true;
      void login(req,res).catch(next).finally(release);
    })).catch(error=>{release();next(error);});
  });
  router.post('/auth/logout',authenticate,async(req,res)=>{
    let user=req.auth.user;
    for(let attempt=0;attempt<3;attempt++) {
      if(!Number.isSafeInteger(user.tokenVersion)||user.tokenVersion>=Number.MAX_SAFE_INTEGER){const error=new Error('Account version unavailable');error.status=503;throw error;}
      user.tokenVersion+=1;
      try {await user.save();return res.json({message:'All existing access tokens for this account have been revoked'});}
      catch(error) {
        if(error.name!=='VersionError') throw error;
        user=await User.findById(req.auth.claims.userId).select('email role accountStatus tokenVersion __v');
        if(!user||user.accountStatus!=='active') return unauthorized(res);
      }
    }
    res.status(409).json({error:'Account changed concurrently; retry logout'});
  });
  router.get('/me',authenticate,(req,res)=>res.json({user:publicUserDTO(req.auth.user)}));
  return router;
}
