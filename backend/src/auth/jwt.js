import jwt from 'jsonwebtoken';
export const JWT_SETTINGS = Object.freeze({algorithm:'HS256',expiresIn:900,issuer:'bookleaf-support-api',audience:'bookleaf-support-web'});
const validSubject = value => typeof value==='string' && /^[a-f0-9]{24}$/i.test(value);
const validVersion = value => Number.isSafeInteger(value) && value>=0;
export function createJwtService(config) {
  if (!Buffer.isBuffer(config.jwtSecret) || config.jwtSecret.length<32) throw new Error('Invalid JWT key configuration');
  const key=Buffer.from(config.jwtSecret);
  return Object.freeze({
    sign({userId,tokenVersion}) {
      const sub=typeof userId==='string'?userId:userId?.toHexString?.();
      if(!validSubject(sub)||!validVersion(tokenVersion)) throw new Error('Invalid JWT identity');
      return jwt.sign({tokenVersion},key,{...JWT_SETTINGS,subject:sub});
    },
    verify(token) {
      try {
        if(typeof token!=='string'||token.length>4096) throw new Error();
        const result=jwt.verify(token,key,{algorithms:[JWT_SETTINGS.algorithm],issuer:JWT_SETTINGS.issuer,audience:JWT_SETTINGS.audience,maxAge:JWT_SETTINGS.expiresIn,complete:true});
        const p=result.payload;
        if(result.header.typ!=='JWT'||!p||typeof p!=='object'||!validSubject(p.sub)||!validVersion(p.tokenVersion)||!Number.isSafeInteger(p.exp)||!Number.isSafeInteger(p.iat)||p.exp-p.iat!==900||p.iat>Math.floor(Date.now()/1000)||p.iss!==JWT_SETTINGS.issuer||p.aud!==JWT_SETTINGS.audience||Object.keys(p).some(k=>!['sub','tokenVersion','iat','exp','iss','aud'].includes(k))) throw new Error();
        return Object.freeze({userId:p.sub,tokenVersion:p.tokenVersion});
      } catch { throw new Error('Invalid or expired access token'); }
    },
  });
}
