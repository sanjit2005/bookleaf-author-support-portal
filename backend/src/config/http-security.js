import { BlockList, isIP } from 'node:net';

export function httpConfiguration(env,mode='development') {
  const production=mode==='production';
  const configured=env.CORS_ALLOWED_ORIGINS;
  if(production&&!configured)throw new Error('CORS_ALLOWED_ORIGINS is required in production');
  const origins=(configured??'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value=>value.trim());
  if(origins.length>20||origins.some(value=>{
    try {const url=new URL(value);return url.hostname.includes('*')||url.origin!==value||url.username||url.password||!['http:','https:'].includes(url.protocol)||production&&url.protocol!=='https:';}
    catch{return true;}
  }))throw new Error('Invalid CORS_ALLOWED_ORIGINS configuration');
  const proxies=env.TRUSTED_PROXY_CIDRS?.trim()?env.TRUSTED_PROXY_CIDRS.split(',').map(value=>value.trim()):[];
  const block=new BlockList();
  for(const value of proxies) {
    const [address,prefix,...extra]=value.split('/'),family=isIP(address);
    const bits=prefix===undefined?(family===4?32:128):Number(prefix);
    if(extra.length||!family||prefix!==undefined&&!/^\d+$/.test(prefix)||!Number.isInteger(bits)||bits<1||bits>(family===4?32:128))throw new Error('Invalid TRUSTED_PROXY_CIDRS configuration');
    block.addSubnet(address,bits,family===4?'ipv4':'ipv6');
  }
  const trustProxy=proxies.length?address=>{
    const normalized=address.startsWith('::ffff:')&&isIP(address.slice(7))===4?address.slice(7):address;
    const family=isIP(normalized);
    return !!family&&block.check(normalized,family===4?'ipv4':'ipv6');
  }:false;
  return {origins:[...new Set(origins)],trustProxy,production};
}
export function configureHttp(application,configuration) {
  application.locals.httpSecurity=configuration;
  application.set('trust proxy',configuration.trustProxy);
}
export function httpSecurity(req,res,next) {
  const config=req.app.locals.httpSecurity;
  res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    // This server serves JSON, not the separately hosted Vite application.
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"});
  // Production is served through an HTTPS edge (Render redirects HTTP to HTTPS).
  // Send policy independently of the internal transport or untrusted forwarded
  // protocol. Browsers ignore HSTS received over HTTP; this does not enable TLS.
  if(config.production)res.set('Strict-Transport-Security','max-age=31536000');
  res.vary('Origin');
  const origin=req.get('Origin');
  if(origin&&!config.origins.includes(origin))return res.status(403).json({error:'Origin not allowed'});
  if(origin)res.set({'Access-Control-Allow-Origin':origin,'Access-Control-Expose-Headers':'Retry-After, RateLimit, RateLimit-Policy'});
  if(req.method==='OPTIONS'&&origin) {
    const headers=(req.get('Access-Control-Request-Headers')||'').split(',').filter(Boolean).map(value=>value.trim().toLowerCase());
    if(!['GET','POST','PATCH','OPTIONS'].includes(req.get('Access-Control-Request-Method'))||headers.some(value=>!['authorization','content-type','if-match'].includes(value)))return res.status(400).json({error:'Invalid preflight request'});
    res.vary('Access-Control-Request-Headers');res.vary('Access-Control-Request-Method');
    return res.set({'Access-Control-Allow-Methods':'GET, POST, PATCH, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, If-Match','Access-Control-Max-Age':'600'}).status(204).end();
  }
  next();
}
