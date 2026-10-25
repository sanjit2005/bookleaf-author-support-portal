export function Icon({name,size=20}) {
  const paths={book:'M4 3h6a3 3 0 0 1 3 3v15a4 4 0 0 0-4-3H4z M20 3h-4a3 3 0 0 0-3 3v15a4 4 0 0 1 4-3h3z',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',ticket:'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M15 5v14',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 M14 7l5 5-5 5',logout:'M9 4H4v16h5 M10 12h11 M17 8l4 4-4 4',spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',leaf:'M20 3C9 2 2 8 6 16c8 5 15-3 14-13z M5 20 15 9',clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',lock:'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4',refresh:'M20 8a9 9 0 1 0 0 9 M20 3v5h-5',check:'m5 12 4 4 10-10'}
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]||paths.book}/></svg>
}
export function Badge({value}) {return <span className={`badge ${String(value||'Unclassified').toLowerCase().replaceAll(' ','-')}`}>{value||'Unclassified'}</span>}
export function ErrorBox({message,retry}) {return message?<div className="alert error" role="alert"><span>{message}</span>{retry&&<button className="text-button" onClick={retry}>Try again</button>}</div>:null}
export function Empty({title='Nothing here yet',children,action}) {return <div className="empty"><span className="empty-icon"><Icon name="book" size={30}/></span><h3>{title}</h3><p>{children}</p>{action}</div>}
export function Loading() {return <div className="loading" role="status"><span className="spinner"/>Loading your workspace…</div>}
export function Resource({resource,children}) {return <><ErrorBox message={resource.error} retry={resource.refresh}/>{resource.loading&&!resource.data?<Loading/>:children}</>}
export function Pager({meta,onPage}) {if(!meta||meta.totalPages<=1&&meta.page<=1)return null;return <div className="pager"><span>Page {meta.page} of {meta.totalPages} · {meta.total} results</span><div><button className="button secondary small" disabled={meta.page<=1} onClick={()=>onPage(meta.page-1)}>Previous</button><button className="button secondary small" disabled={meta.page>=meta.totalPages} onClick={()=>onPage(meta.page+1)}>Next</button></div></div>}
export function Heading({eyebrow,title,children,action}) {return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children&&<p className="subtitle">{children}</p>}</div>{action}</div>}
export function Field({label,children,hint,htmlFor}) {
  const generated=useId(),id=htmlFor||children.props.id||generated
  const control=['input','select','textarea'].includes(children.type)?cloneElement(children,{id,'aria-describedby':hint?`${id}-hint`:undefined}):children
  return <div className="field"><label htmlFor={id}>{label}</label>{control}{hint&&<small id={`${id}-hint`}>{hint}</small>}</div>
}
export function Refresh({onClick}) {return <button className="button secondary" onClick={onClick}><Icon name="refresh"/>Refresh</button>}
import { cloneElement, useId } from 'react'
