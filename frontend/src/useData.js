import { useCallback, useEffect, useState } from 'react'

// One read at a time; schedule the next poll only after the previous read settles.
export function useData(load,{poll=0,paused=false}={}) {
  const [version,setVersion]=useState(0)
  const [snapshot,setSnapshot]=useState({load:null,version:-1,data:null,error:null,updated:null})
  const refresh=useCallback(()=>setVersion(value=>value+1),[])
  useEffect(()=>{
    if(paused) return
    let live=true,timer
    const controller=new AbortController()
    async function read() {
      if(document.hidden&&poll){timer=setTimeout(read,poll);return}
      try {
        const data=await load(controller.signal)
        if(live) setSnapshot({load,version,data,error:null,updated:new Date()})
      } catch(error) {
        if(live&&!controller.signal.aborted) setSnapshot(previous=>({load,version,data:previous.load===load?previous.data:null,error:error.message,updated:previous.updated}))
      } finally {if(live&&poll)timer=setTimeout(read,poll)}
    }
    read()
    return ()=>{live=false;clearTimeout(timer);controller.abort()}
  },[load,poll,paused,version])
  return {data:snapshot.load===load?snapshot.data:null,error:snapshot.load===load?snapshot.error:null,
    loading:snapshot.load!==load||snapshot.version!==version,updated:snapshot.updated,refresh}
}
export function useQuery(client,path,options) {
  const load=useCallback(signal=>client(path,{signal}),[client,path])
  return useData(load,options)
}
