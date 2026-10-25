import { useCallback, useState } from 'react'
import { useData } from './useData'
import { Heading, Field, ErrorBox, Loading, Icon } from './ui'
import { CATEGORIES } from './format'

export default function CreateTicket({client,navigate,onDirty,initialBook=''}) {
  const [selectedFiles,setSelectedFiles]=useState(0)
  const [form,setForm]=useState({subject:'',description:'',category:'',book_id:initialBook}),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const load=useCallback(async signal=>{
    const items=[];let page=1,pages=1
    while(page<=pages){const result=await client(`/me/books?page=${page}&limit=50`,{signal});items.push(...result.books);pages=result.pagination.totalPages;if(pages>100)throw new Error('There are too many titles to load safely. Please contact support.');page++}
    return items
  },[client])
  const books=useData(load)
  const change=(field,value)=>{setForm(previous=>({...previous,[field]:value}));onDirty(true)}
  async function submit(event) {
    event.preventDefault();if(busy)return
    if(!form.subject.trim()||!form.description.trim()||form.subject.includes('\0')||form.description.includes('\0')){setError('Please add a subject and description without null characters.');return}
    setBusy(true);setError('')
    try {
      const result=await client('/me/tickets',{method:'POST',body:{...form,category:form.category||null,book_id:form.book_id||null}})
      onDirty(false);navigate(`/tickets/${result.ticket._id}`,null,true)
    } catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  return <><button className="text-button back" onClick={()=>navigate('/tickets')}>← Back to tickets</button><Heading eyebrow="LET’S TALK" title="How can we help?">Give us a few details. Your publishing team will take it from here.</Heading><div className="create-layout"><form className="panel form-panel" onSubmit={submit}><ErrorBox message={error}/><ErrorBox message={books.error} retry={books.refresh}/>{books.loading&&!books.data?<Loading/>:<Field label="Which book is this about?"><select value={form.book_id} onChange={e=>change('book_id',e.target.value)} disabled={busy||!!books.error}><option value="">General / Account Level</option>{books.data?.map(book=><option key={book.book_id} value={book.book_id}>{book.title} · {book.book_id}</option>)}</select></Field>}<Field label="Subject" hint={`${form.subject.length}/200 characters`}><input required maxLength={200} value={form.subject} onChange={e=>change('subject',e.target.value)} placeholder="A short summary of your question" disabled={busy}/></Field><Field label="Category (optional)" hint="Leave this open if you’re unsure. The team can classify your query."><select value={form.category} onChange={e=>change('category',e.target.value)} disabled={busy}><option value="">Help me choose</option>{CATEGORIES.map(category=><option key={category}>{category}</option>)}</select></Field><Field label="Tell us more" hint={`${form.description.length}/10,000 characters`}><textarea required rows={8} maxLength={10000} value={form.description} onChange={e=>change('description',e.target.value)} placeholder="What happened, what were you expecting, and how can we help?" disabled={busy}/></Field><Field label="Attachments (optional · selection only)" hint="Upload is not supported yet. Selected files stay on your device; they are not submitted or visible to support staff."><input type="file" multiple disabled={busy} onChange={event=>{setSelectedFiles(event.target.files.length);onDirty(true)}}/></Field>{selectedFiles>0&&<p className="alert warning" role="status">{selectedFiles} file(s) selected locally only. This ticket will be submitted without attachments.</p>}<div className="form-footer"><button className="button secondary" type="button" onClick={()=>navigate('/tickets')} disabled={busy}>Cancel</button><button className="button" disabled={busy||books.loading||!!books.error}>{busy?'Submitting your query…':'Submit support ticket'}<Icon name="arrow" size={17}/></button></div></form><aside className="support-note"><span className="empty-icon"><Icon name="leaf" size={32}/></span><h2>A little context goes a long way.</h2><p>Include the relevant book, platform or order reference, and what you’d like us to investigate.</p><p>Please leave passwords, bank details and sensitive account information out of your message.</p><div className="note-rule"/><small>Your query stays linked to your author account. You can follow the conversation in My Tickets.</small></aside></div></>
}
