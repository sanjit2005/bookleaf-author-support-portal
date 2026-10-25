const base=(import.meta.env.VITE_API_BASE_URL||'').replace(/\/$/,'')
export function createClient(token='',onUnauthorized=()=>{}) {
  return async function request(path,{method='GET',body,signal,headers={}}={}) {
    const accessToken=typeof token==='function'?token():token
    if(typeof token==='function'&&!accessToken){const error=new Error('Sign in again to continue. Your unsent work has been kept.');error.status=401;throw error}
    const write=method!=='GET'&&!path.startsWith('/auth/')
    const controller=new AbortController()
    const abort=()=>controller.abort()
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted) controller.abort()
    const timer=setTimeout(abort,25000)
    try {
      const response=await fetch(`${base}/api${path}`,{method,signal:controller.signal,redirect:'error',credentials:'omit',
        headers:{Accept:'application/json',...headers,...(accessToken?{Authorization:`Bearer ${accessToken}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})})
      const data=await response.json().catch(()=>null)
      if(signal?.aborted) throw new DOMException('Aborted','AbortError')
      if(response.status===401&&accessToken) onUnauthorized(accessToken)
      if(!response.ok) {
        const message=response.status===401?(accessToken?'Your session expired. Sign in again to continue.':'The email or password was not accepted. Check your credentials and try again.'):response.status===429?'Too many requests. Please wait a little before trying again.':response.status===409?'The ticket changed, or that action is not allowed in its current state. Refresh and try again.':response.status===503?'Support service is temporarily unavailable. Please try again shortly.':response.status>=500?'The server could not complete the request. Please try again shortly.':data?.error||'The request could not be completed.'
        const error=new Error(message);error.status=response.status;throw error
      }
      if(!data) throw new Error(write?'The server returned an unexpected response. Check whether your changes were saved before resubmitting.':'The server returned an unexpected response. Please retry.')
      return data
    } catch(error) {
      if(signal?.aborted) throw error
      if(error.name==='AbortError') throw new Error('The request timed out. Before repeating a submission, check whether it was saved.',{cause:error})
      if(error instanceof TypeError) throw new Error(write?'The connection was interrupted. Check whether your changes were saved before resubmitting.':'Cannot reach the server. Check your connection and retry.',{cause:error})
      throw error
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort)}
  }
}

// Memory-only token vault. The request function remains stable during reauthentication.
export function createMemoryClient(onUnauthorized) {
  let token=''
  return {request:createClient(()=>token,rejected=>{if(token!==rejected)return;token='';onUnauthorized()}),setToken(value){token=value}}
}
