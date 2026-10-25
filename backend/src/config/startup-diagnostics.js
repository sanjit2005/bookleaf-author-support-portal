// Only fixed, allowlisted text reaches startup logs. Never serialize an Error,
// its cause/stack, configuration, URI, or arbitrary driver message/code.
const messages={
  ENVIRONMENT_LOAD_FAILED:'Unable to read or parse backend environment configuration',
  CONFIGURATION_INVALID:'Backend configuration is invalid',
  MONGODB_URI_INVALID:'Invalid MONGODB_URI configuration',
  JWT_SECRET_INVALID:'JWT_SECRET does not meet signing-secret requirements',
  PORT_INVALID:'Invalid PORT configuration',
  NODE_ENV_INVALID:'Invalid NODE_ENV configuration',
  GEMINI_MODEL_INVALID:'Invalid GEMINI_MODEL configuration',
  CORS_REQUIRED:'CORS_ALLOWED_ORIGINS is required in production',
  CORS_INVALID:'Invalid CORS_ALLOWED_ORIGINS configuration',
  PROXY_CONFIGURATION_INVALID:'Invalid TRUSTED_PROXY_CIDRS configuration',
  APPLICATION_CONFIGURATION_FAILED:'Unable to initialize application configuration',
  DATABASE_CONNECTION_FAILED:'Database connection failed',
  DATABASE_AUTHENTICATION_FAILED:'Database authentication failed',
  DATABASE_DNS_FAILED:'Database hostname resolution failed',
  DATABASE_TIMEOUT:'Database connection timed out',
  DATABASE_NETWORK_FAILED:'Database network connection failed',
  DATABASE_SELECTION_FAILED:'Database server selection failed',
  HTTP_LISTEN_FAILED:'Unable to start HTTP listener',
  HTTP_ADDRESS_IN_USE:'HTTP listen address is already in use',
  HTTP_PERMISSION_DENIED:'HTTP listener permission denied',
};
export class StartupDiagnosticError extends Error {
  constructor(category,message=messages[category]) {
    super(message);this.category=category;
  }
}
const validationCategories=new Map([
  ['Invalid MONGODB_URI configuration','MONGODB_URI_INVALID'],
  ['JWT_SECRET must be hex encoding of at least 32 cryptographically random bytes','JWT_SECRET_INVALID'],
  ['Invalid PORT configuration','PORT_INVALID'],['Invalid NODE_ENV configuration','NODE_ENV_INVALID'],
  ['Invalid GEMINI_MODEL configuration','GEMINI_MODEL_INVALID'],
  ['CORS_ALLOWED_ORIGINS is required in production','CORS_REQUIRED'],
  ['Invalid CORS_ALLOWED_ORIGINS configuration','CORS_INVALID'],
  ['Invalid TRUSTED_PROXY_CIDRS configuration','PROXY_CONFIGURATION_INVALID'],
]);
export function configurationFailure(error) {
  const category=validationCategories.get(error?.message)||'CONFIGURATION_INVALID';
  // Preserve existing safe validation messages for CLI callers, not raw errors.
  return new StartupDiagnosticError(category,validationCategories.has(error?.message)?error.message:messages[category]);
}
export function databaseFailure(error) {
  let category='DATABASE_CONNECTION_FAILED';
  if(error?.code===18)category='DATABASE_AUTHENTICATION_FAILED';
  else if(['ENOTFOUND','EAI_AGAIN'].includes(error?.code))category='DATABASE_DNS_FAILED';
  else if(error?.code==='ETIMEDOUT'||error?.name==='MongoNetworkTimeoutError')category='DATABASE_TIMEOUT';
  else if(['ECONNRESET','ECONNREFUSED'].includes(error?.code)||error?.name==='MongoNetworkError')category='DATABASE_NETWORK_FAILED';
  else if(['MongoServerSelectionError','MongooseServerSelectionError'].includes(error?.name))category='DATABASE_SELECTION_FAILED';
  return new StartupDiagnosticError(category);
}
export function startupDiagnostic(stage,error) {
  let category={environment_load:'ENVIRONMENT_LOAD_FAILED',environment_validation:'APPLICATION_CONFIGURATION_FAILED',database_connection:'DATABASE_CONNECTION_FAILED',http_listener:'HTTP_LISTEN_FAILED'}[stage];
  if(error instanceof StartupDiagnosticError&&Object.hasOwn(messages,error.category)) {
    category=error.category;
    if([...validationCategories.values(),'CONFIGURATION_INVALID'].includes(category))stage='environment_validation';
  } else if(stage==='http_listener') {
    if(error?.code==='EADDRINUSE')category='HTTP_ADDRESS_IN_USE';
    if(error?.code==='EACCES')category='HTTP_PERMISSION_DENIED';
  }
  return {event:'backend_startup_failed',stage,category,message:messages[category]};
}
