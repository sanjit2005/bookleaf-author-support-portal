import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import app from './app.js';
import { configureHttp } from './config/http-security.js';
import { loadEnvironment } from './config/environment.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { createJwtService } from './auth/jwt.js';
import { createAIService } from './ai/service.js';
// Importing this module never starts a server or opens a connection.
export async function startServer({loadConfig=loadEnvironment,connect=connectDatabase,disconnect=disconnectDatabase,application=app}={}) {
  const config=await loadConfig();
  if(config.httpSecurity)configureHttp(application,config.httpSecurity);
  if(application.locals) {
    application.locals.jwtService=createJwtService(config);
    application.locals.aiService=createAIService({apiKey:config.geminiApiKey,model:config.geminiModel});
  }
  let server;
  try {
    await connect(config.mongodbUri);
    server=application.listen(config.port,'0.0.0.0');
    await once(server,'listening');
  } catch {
    try { if(server) server.close(); } catch { /* still attempt database cleanup */ }
    try { await disconnect(); } catch { /* sanitized by caller */ }
    throw new Error('Backend startup failed');
  }
  let stopping;
  const shutdown=()=>{
    if(stopping) return stopping;
    stopping=(async()=>{
      let timer;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{server.closeAllConnections?.();reject(new Error('Shutdown timed out'));},10000);});
      try {
        await Promise.race([new Promise((resolve,reject)=>server.close(error=>error?reject(new Error('HTTP shutdown failed')):resolve())),deadline]);
      } finally {
        try { await Promise.race([disconnect(),deadline]); }
        finally {clearTimeout(timer);}
      }
    })();
    return stopping;
  };
  return {server,shutdown};
}
async function main(){
  try {
    const running=await startServer();
    console.log('BookLeaf backend started');
    const stop=()=>{running.shutdown().then(()=>process.exit(0),()=>{console.error('Backend shutdown failed');process.exit(1);});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    running.server.on('error',()=>{console.error('HTTP server failed');process.exitCode=1;void running.shutdown().catch(()=>process.exit(1));});
  } catch {console.error('Backend startup failed; check environment, database access and port availability');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) void main();
