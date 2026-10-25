import { Router } from 'express';
import { randomBytes } from 'node:crypto';
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
  return rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,
    message:{error:'Too many login attempts; try again later'},...options});
}
export function createAuthRouter({loginLimiter=createLoginLimiter()}={}) {
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.post('/auth/login',loginLimiter,async(req,res)=>{
    const input=credentials(req.body);
    if(!input) return unauthorized(res);
    const service=jwtFor(req);
    const user=await User.findOne({email:input.email}).select('+passwordHash email role accountStatus tokenVersion');
    const usable=Boolean(user&&validPasswordHash(user.passwordHash));
    const matched=await bcrypt.compare(input.password,usable?user.passwordHash:await fallbackHash());
    if(!matched||!usable||user.accountStatus!=='active'||!['author','admin'].includes(user.role)) return unauthorized(res);
    const accessToken=service.sign({userId:user._id,tokenVersion:user.tokenVersion});
    res.json({accessToken,tokenType:'Bearer',expiresIn:JWT_SETTINGS.expiresIn,user:publicUserDTO(user)});
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
