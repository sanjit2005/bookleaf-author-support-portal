import { useCallback, useEffect, useRef, useState } from 'react'

const empty={path:null,items:[],nextCursor:null,hasMore:false,ready:false,pending:false,error:null,busy:false,requestId:0}
function merge(...groups) {
  const unique=new Map()
  for(const entry of groups.flat())if(!unique.has(entry._id))unique.set(entry._id,entry)
  return [...unique.values()].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b._id.localeCompare(a._id))
}
function pageResult(result,key) {
  const items=result[key],paging=result.pagination
  if(!Array.isArray(items)||items.some(item=>typeof item._id!=='string'||typeof item.body!=='string'||!Number.isFinite(Date.parse(item.createdAt)))||
    !paging||typeof paging.hasMore!=='boolean'||(paging.hasMore?typeof paging.nextCursor!=='string':paging.nextCursor!==null))throw new Error('Unexpected history response. Please retry.')
  return {items:merge(items),nextCursor:paging.nextCursor,hasMore:paging.hasMore}
}
// Poll only the latest bounded window. Older reads use immutable timestamp/ID cursors.
export function useHistory(client,path,key,{paused=false}={}) {
  const [snapshot,setSnapshot]=useState(empty)
  const active=useRef(null),sequence=useRef(0)
  const pausePolling=paused&&snapshot.path===path&&snapshot.ready
  const read=useCallback(async(kind='poll',before=null)=>{
    if(!path)return
    if(active.current) {
      if(kind==='poll'||active.current.kind!=='poll')return
      active.current.controller.abort()
    }
    const request={kind,controller:new AbortController(),id:++sequence.current}
    active.current=request
    if(kind!=='poll')setSnapshot(previous=>({...previous,...(previous.path===path?{}:empty),path,busy:true,error:null,requestId:request.id}))
    try {
      const query=new URLSearchParams({limit:'10',...(before?{before}:{})})
      const result=pageResult(await client(`${path}?${query}`,{signal:request.controller.signal}),key)
      if(request.controller.signal.aborted||active.current!==request)return
      setSnapshot(previous=>{
        const current=previous.path===path?previous:{...empty,path}
        if(!current.ready||kind==='latest')return {...current,...result,ready:true,pending:false,error:null}
        if(kind==='older')return {...current,...result,items:merge(current.items,result.items),error:null}
        // Do not insert incoming replies above a reader's current position automatically.
        const known=new Set(current.items.map(item=>item._id))
        return {...current,pending:current.pending||result.items.some(item=>!known.has(item._id)),error:null}
      })
    } catch(error) {
      if(!request.controller.signal.aborted&&active.current===request)setSnapshot(previous=>({...previous,...(previous.path===path?{}:empty),path,error:error.message,retryKind:kind,retryBefore:before}))
    } finally {
      if(active.current===request) {
        active.current=null
        if(kind!=='poll')setSnapshot(previous=>previous.requestId===request.id?{...previous,busy:false}:previous)
      }
    }
  },[client,path,key])
  useEffect(()=>()=>{active.current?.controller.abort();active.current=null},[client,path])
  useEffect(()=>{
    if(!path||pausePolling)return
    let live=true,timer
    async function poll() {
      if(!document.hidden)await read()
      if(live)timer=setTimeout(poll,20000)
    }
    void poll()
    return ()=>{
      live=false;clearTimeout(timer)
      if(active.current?.kind==='poll'){active.current.controller.abort();active.current=null}
    }
  },[path,pausePolling,read])
  const insert=useCallback(entry=>{
    active.current?.controller.abort();active.current=null
    setSnapshot(previous=>({...previous,path,items:merge([entry],previous.path===path?previous.items:[]),ready:true,busy:false,error:null,requestId:0}))
  },[path])
  const state=snapshot.path===path?snapshot:empty
  return {...state,insert,showLatest:()=>read('latest'),loadOlder:()=>read('older',state.nextCursor),retry:()=>read(state.retryKind==='poll'?'check':state.retryKind??'latest',state.retryBefore??null)}
}
