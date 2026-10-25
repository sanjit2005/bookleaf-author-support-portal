import { useCallback, useEffect, useRef, useState } from 'react'
import { useData } from './useData'
import { useHistory } from './useHistory'
import Conversation from './Conversation'
import { Badge, Heading, Resource, ErrorBox, Field, Icon } from './ui'
import { CATEGORIES, PRIORITIES, STATUSES, date, refId } from './format'

function Management({ticket,observedRevision,user,client,path,onEdit,onSaved,onAccepted}) {
  const values=value=>({status:value.status,category:value.category||'',priority:value.priority,assignee:refId(value.assignee)||''})
  const baseline=ticket
  const [form,setForm]=useState(()=>values(baseline)),[touched,setTouched]=useState([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState(false),[conflict,setConflict]=useState(false)
  // Only initial load, explicit reconciliation and confirmed saves advance this baseline.
  const needsReconciliation=conflict||observedRevision>baseline.revision
  function accept(serverTicket) {
    if(serverTicket?._id!==baseline._id||!Number.isSafeInteger(serverTicket.revision)||serverTicket.revision<baseline.revision)throw new Error('Unable to accept ticket details. Your edits are kept; try loading current details again.')
    // PATCH can return bare reference IDs. Keep an already permitted summary only
    // when its ID still matches, so accepting a save does not lose book/author labels.
    const accepted={...serverTicket}
    for(const key of ['author','book','assignee'])if(typeof serverTicket[key]==='string'&&refId(baseline[key])===serverTicket[key])accepted[key]=baseline[key]
    onAccepted(accepted)
  }
  function reset() {
    setForm(values(baseline));setTouched([]);setSuccess(false);setError('');onEdit(false)
    // Reset discards local fields, not the requirement to reconcile a known conflict.
  }
  const change=(key,value)=>{setForm(previous=>({...previous,[key]:value}));setTouched(previous=>[...new Set([...previous,key])]);onEdit(true);setSuccess(false)}
  async function reconcile() {
    setBusy(true);setError('')
    try {const result=await client(path+'?view=summary');accept(result.ticket);setForm(previous=>({...values(result.ticket),...Object.fromEntries(touched.map(key=>[key,previous[key]]))}));setConflict(false);setSuccess(false)}
    catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  async function save(event) {
    event.preventDefault();if(busy||needsReconciliation)return
    if(!Number.isSafeInteger(baseline.revision)||baseline.revision<0){setError('Ticket revision unavailable. Refresh ticket details before editing.');return}
    const body=Object.fromEntries(Object.entries({...form,category:form.category||null,assignee:form.assignee||null}).filter(([key])=>touched.includes(key)))
    if(!Object.keys(body).length){onEdit(false);setSuccess(true);return}
    setBusy(true);setError('')
    try {
      const result=await client(path,{method:'PATCH',body,headers:{'If-Match':JSON.stringify(String(baseline.revision))}})
      accept(result.ticket);setForm(values(result.ticket));setTouched([]);onEdit(false);setSuccess(true);onSaved()
    }catch(failure){if(failure.status===409){setConflict(true);setError('This ticket changed or the transition was rejected. Your edits are kept. Load current details, compare them, and reconcile before saving again.')}else setError(failure.message)}finally{setBusy(false)}
  }
  return <form className="panel management" onSubmit={save}><div className="panel-heading"><h2>Ticket management</h2></div><div className="panel-pad"><ErrorBox message={error}/>{needsReconciliation&&<button type="button" className="button secondary full" disabled={busy} onClick={reconcile}>Load current details to reconcile</button>}<p className="history-status muted" role="status">Accepted server revision {baseline.revision}. Current saved values: {baseline.status}; {baseline.priority}; {baseline.category||'Unclassified'}; assignee {refId(baseline.assignee)||'Unassigned'}. The fields below may contain local unsaved changes. Reset edits restores these accepted values.</p>{needsReconciliation&&<p className="alert warning" role="status">Newer details or a conflict need reconciliation. Load current details before saving; local edits are kept.</p>}{success&&<p className="success" role="status">Changes saved.</p>}<Field label="Status"><select value={form.status} onChange={e=>change('status',e.target.value)} disabled={busy}>{STATUSES.map(value=><option key={value}>{value}</option>)}</select></Field><small className="muted">To reopen a resolved or closed ticket, choose In Progress. The server validates all transitions.</small><Field label="Priority"><select value={form.priority} onChange={e=>change('priority',e.target.value)} disabled={busy}>{PRIORITIES.map(value=><option key={value}>{value}</option>)}</select></Field><Field label="Category"><select value={form.category} onChange={e=>change('category',e.target.value)} disabled={busy}><option value="">Unclassified</option>{CATEGORIES.map(value=><option key={value}>{value}</option>)}</select></Field><Field label="Assignee" hint="Enter an active admin User ID, assign yourself, or clear to unassign."><input value={form.assignee} onChange={e=>change('assignee',e.target.value)} pattern="[a-fA-F0-9]{24}" placeholder="Unassigned" disabled={busy}/></Field><div className="assignment-actions"><button type="button" className="text-button" disabled={busy} onClick={()=>change('assignee',user._id)}>Assign to me</button><button type="button" className="text-button" disabled={busy} onClick={()=>change('assignee','')}>Unassign</button></div><button type="button" className="text-button" disabled={busy||!form.category} onClick={()=>{setTouched(previous=>[...new Set([...previous,'category','priority'])]);onEdit(true);setSuccess(false)}}>Confirm category and priority reviewed</button><button className="button full" disabled={busy||needsReconciliation}>{busy?'Saving…':'Save changes'}</button><button type="button" className="text-button" disabled={busy} onClick={reset}>Reset edits</button></div></form>
}
export default function TicketDetail({client,user,ticketId,navigate,onDirty}) {
  const admin=user.role==='admin',path=`/${admin?'admin':'me'}/tickets/${encodeURIComponent(ticketId)}`
  const [reply,setReply]=useState(''),[note,setNote]=useState(''),[managementDirty,setManagementDirty]=useState(false)
  const [job,setJob]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[draftNeedsReview,setDraftNeedsReview]=useState(false),[reviewed,setReviewed]=useState(false)
  const opening=useRef({attempted:false,edited:false,version:0,reply:''}),mounted=useRef(false)
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false}},[])
  const writing=useRef(false),dirty=!!reply||!!note||managementDirty,paused=dirty||!!job
  const [acceptedTicket,setAcceptedTicket]=useState(null)
  const load=useCallback(async signal=>{
    const result=await client(`${path}?view=summary`,{signal})
    if(admin&&!signal.aborted)setAcceptedTicket(previous=>previous??result.ticket)
    return result
  },[admin,client,path])
  const resource=useData(load,{poll:20000,paused})
  const messages=useHistory(client,`${path}/messages`,'messages',{paused})
  const notes=useHistory(client,admin?`${path}/notes`:null,'notes',{paused})
  const ticket=admin?acceptedTicket:resource.data?.ticket,canReply=ticket&&['Open','In Progress'].includes(ticket.status)
  const editReply=value=>{opening.current.edited=true;opening.current.version++;opening.current.reply=value;setReply(value);setReviewed(false);onDirty(!!value||!!note||managementDirty)}
  const editNote=value=>{setNote(value);onDirty(!!reply||!!value||managementDirty)}
  const editManagement=value=>{setManagementDirty(value);onDirty(!!reply||!!note||value)}
  async function send(kind,event) {
    event.preventDefault();if(writing.current)return
    const value=kind==='notes'?note:reply
    if(!value.trim()||value.includes('\0')){setError('Write a message without null characters before submitting.');return}
    if(kind==='messages'&&draftNeedsReview&&!reviewed){setError('Review the AI draft and tick the confirmation before sending.');return}
    writing.current=true;setJob(kind);setError('');setNotice('')
    try {
      const result=await client(`${path}/${kind}`,{method:'POST',body:{body:value}})
      const entry=kind==='notes'?result.note:result.message
      if(!entry||typeof entry._id!=='string'||typeof entry.body!=='string'||!Number.isFinite(Date.parse(entry.createdAt)))throw new Error('The reply may have been saved. Check the latest history before submitting again.')
      if(kind==='notes') {
        notes.insert(entry);setNote('');onDirty(!!reply||managementDirty)
      } else {
        messages.insert({...entry,sender:typeof entry.sender==='string'?{_id:entry.sender,role:user.role}:entry.sender})
        opening.current.reply='';opening.current.version++;setReply('');setDraftNeedsReview(false);setReviewed(false);onDirty(!!note||managementDirty)
      }
      setNotice(kind==='notes'?'Internal note saved. Only admins can see it.':'Your public reply was sent.')
      resource.refresh()
    }catch(failure){setError(failure.message)}finally{writing.current=false;setJob('')}
  }
  const draft=useCallback(async(automatic=false)=>{
    if(!mounted.current||writing.current)return
    const context=opening.current
    if(automatic&&(context.edited||context.reply))return
    if(!automatic&&context.reply&&!window.confirm('Replace the current reply with a new AI draft?'))return
    const version=context.version
    writing.current=true;setJob(automatic?'initial-draft':'draft');setError('');setNotice('')
    try {
      const result=await client(`${path}/draft`,{method:'POST',body:{}})
      if(!mounted.current)return
      if(typeof result.draft!=='string'||!result.draft.trim()||result.draft.length>3000||result.draft.includes('\0')||result.requiresReview!==true)throw new Error('Invalid draft')
      // A response belongs to this opening, but local typing always wins—even
      // when the admin subsequently clears the text. Never restore stale text.
      if(opening.current.version!==version){setNotice('Your reply changed while AI was preparing a draft. Your text has been kept.');return}
      opening.current.reply=result.draft
      setReply(result.draft);setDraftNeedsReview(true);setReviewed(false);onDirty(true)
      setNotice('Draft ready. Review facts and commitments, edit as needed, then send manually.'+(Array.isArray(result.contextWarnings)&&result.contextWarnings.length?' Some context was unavailable or shortened. Verify the source details before sending.':''))
    } catch {
      if(mounted.current)setError('AI drafting is unavailable right now. You can still write and send a reply manually.')
    } finally {writing.current=false;if(mounted.current)setJob('')}
  },[client,path,onDirty])
  useEffect(()=>{
    if(!admin||!canReply||opening.current.attempted)return
    // Set before scheduling: effect replay, polling, reauthentication and ordinary
    // rerenders cannot repeat a paid request. Leaving/reopening is a new context.
    opening.current.attempted=true
    void Promise.resolve().then(()=>draft(true))
  },[admin,canReply,draft])
  return <><button className="text-button back" onClick={()=>navigate('/tickets')}>← Back to tickets</button><Resource resource={resource}>{ticket&&<>
    <Heading eyebrow={`SUPPORT TICKET · ${ticket._id.slice(-8).toUpperCase()}`} title={ticket.subject} action={<Badge value={ticket.status}/>}>Opened {date(ticket.createdAt)} · Last activity {date(ticket.lastActivityAt)}</Heading>
    <div className="ticket-meta"><Badge value={ticket.priority}/><span>{ticket.category||'Awaiting classification'}</span><span>{ticket.book?.title||'General / Account Level'}</span>{admin&&<span>Author: {ticket.author?.name||'Author'} · {ticket.author?.author_id||refId(ticket.author)}</span>}</div>
    {admin&&ticket.classification?.needsManualReview&&<div className="alert warning"><Icon name="spark"/>AI classification needs manual review. Check the category and priority.</div>}
    {admin&&ticket.classification&&<section className="panel panel-pad" aria-label="Classification provenance"><h2>Classification provenance</h2><p>Effective classification ({ticket.categorySource||'pending'} category / {ticket.prioritySource||'fallback'} priority): {ticket.category||'Unclassified'} · {ticket.priority}</p><p>AI attempt: {ticket.classification.state}. Suggestion: {ticket.classification.suggestedCategory||'Unavailable'} · {ticket.classification.suggestedPriority||'Unavailable'}.</p>{ticket.classification.errorCode&&<p>AI failure: {ticket.classification.errorCode}</p>}<p>{ticket.classification.manuallyReviewed?'Category and priority manually reviewed by an admin. This does not validate the original AI result.':'Admin review of both fields has not been recorded.'}</p></section>}
    <ErrorBox message={error}/>{notice&&<div className="alert success" role="status">{notice}</div>}
    <div className={admin?'ticket-layout':'author-conversation'}><div>
      <section className="panel query-panel"><div className="panel-heading"><h2>Original query</h2><small>{date(ticket.createdAt)}</small></div><p className="prose-text">{ticket.description}</p></section>
      <form className="panel composer" onSubmit={e=>send('messages',e)}>
        <div className="panel-heading"><h2>{admin?'Reply to author':'Add a reply'}</h2>{admin&&<button className="button ai-button small" type="button" onClick={()=>draft(false)} disabled={!!job||!canReply}><Icon name="spark" size={16}/>{job==='draft'||job==='initial-draft'?'Preparing draft…':'Draft with AI'}</button>}</div>
        <div className="panel-pad">{job==='initial-draft'&&<p className="muted" role="status">Preparing an initial AI draft. You can start writing; your text will be kept.</p>}{!canReply&&<p className="alert warning">This ticket is {ticket.status.toLowerCase()}. {admin?'Reopen it with In Progress to reply.':'An admin must reopen it before you can reply.'}</p>}
          <Field label={draftNeedsReview?'Editable AI draft · review before sending':'Your message'}><textarea maxLength={10000} rows={6} required value={reply} disabled={(!!job&&job!=='initial-draft')||!canReply} onChange={e=>editReply(e.target.value)} placeholder="Write a thoughtful reply…"/></Field>
          {draftNeedsReview&&<label className="checkbox-label"><input type="checkbox" checked={reviewed} disabled={!!job} onChange={e=>setReviewed(e.target.checked)}/>I have reviewed the facts, policy and commitments in this draft.</label>}
          <div className="composer-footer"><small className="muted">{reply.length}/10,000 · visible to {admin?'the author':'the support team'}</small><button className="button" disabled={!!job||!canReply||!messages.ready||!reply.trim()||(draftNeedsReview&&!reviewed)}>{job==='messages'?'Sending…':'Send reply'}<Icon name="arrow" size={16}/></button></div>
        </div>
      </form>
      <Conversation history={messages}/>
    </div>{admin&&<aside>
      <Management key={ticket._id} ticket={ticket} observedRevision={resource.data?.ticket.revision} onAccepted={setAcceptedTicket} user={user} client={client} path={path} onEdit={editManagement} onSaved={()=>{setNotice('Ticket details saved.');resource.refresh()}}/>
      <Conversation history={notes} privateNotes><form className="panel-pad" onSubmit={e=>send('notes',e)}><Field label="New internal note"><textarea required maxLength={10000} rows={4} value={note} disabled={!!job} onChange={e=>editNote(e.target.value)} placeholder="Context for the operations team only…"/></Field><button className="button secondary full" disabled={!!job||!notes.ready||!note.trim()}>{job==='notes'?'Saving note…':'Save private note'}</button></form></Conversation>
    </aside>}</div>
    <p className="poll-status"><span className={paused?'status-dot paused':'status-dot'}/>{paused?'Live updates paused while you edit.':'Checks for updates every 20 seconds.'}<button className="text-button" disabled={paused} onClick={resource.refresh}>Refresh ticket details</button></p>
  </>}</Resource></>
}
