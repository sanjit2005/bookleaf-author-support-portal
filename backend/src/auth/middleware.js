import { User, Author } from '../models/index.js';

export const unauthorized = res => res.status(401).json({error:'Authentication required or invalid credentials'});
export function jwtFor(req) {
  const service=req.app.locals.jwtService;
  if(!service) {const error=new Error('Authentication unavailable');error.status=503;throw error;}
  return service;
}
export function requireRole(...roles) {
  if(!roles.length||roles.some(role=>!['author','admin'].includes(role))) throw new Error('Invalid role restriction');
  return (req,res,next)=>{
    if(!req.auth?.user) return unauthorized(res);
    if(!roles.includes(req.auth.user.role)) return res.status(403).json({error:'Forbidden'});
    next();
  };
}
export function createAuthMiddleware(models={User,Author}) {
  const {User,Author}=models;
  async function authenticate(req,res,next) {
    const header=req.get('authorization');
    if(typeof header!=='string'||!/^Bearer [^\s,]+$/i.test(header)) return unauthorized(res);
    const service=jwtFor(req);
    let claims;
    try {claims=service.verify(header.slice(7));} catch {return unauthorized(res);}
    // Do not catch database failures as invalid credentials; let the safe error handler respond.
    const user=await User.findById(claims.userId).select('email role accountStatus tokenVersion __v');
    if(!user||user.accountStatus!=='active'||!['author','admin'].includes(user.role)||user.tokenVersion!==claims.tokenVersion) return unauthorized(res);
    req.auth={user,claims};
    next();
  }
  // Run after authenticate and requireRole('author'); never resolve a caller-supplied ID.
  async function resolveAuthor(req,res,next) {
    const author=await Author.findOne({user:req.auth.user._id}).select('_id').lean();
    if(!author) return res.status(403).json({error:'Author profile unavailable'});
    req.auth.authorId=author._id;
    next();
  }
  return {authenticate,resolveAuthor,requireRole};
}
const defaults=createAuthMiddleware();
export const authenticate=defaults.authenticate;
export const resolveAuthor=defaults.resolveAuthor;
