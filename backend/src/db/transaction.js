export function requireTransaction(session) {
  if(!session || session.hasEnded || typeof session.inTransaction!=='function' || session.inTransaction()!==true) throw new Error('An active transaction session is required');
}
