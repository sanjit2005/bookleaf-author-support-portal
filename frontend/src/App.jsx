import { useCallback, useEffect, useState } from 'react'
import { createClient, createMemoryClient } from './api'
import { ErrorBox, Field, Icon } from './ui'
import Dashboard from './Dashboard'
import { Books, BookDetail } from './Books'
import TicketList from './TicketList'
import CreateTicket from './CreateTicket'
import TicketDetail from './TicketDetail'

function Login({onLogin,message}) {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[visible,setVisible]=useState(false)
  async function submit(event) {
    event.preventDefault();if(busy)return
    setBusy(true);setError('')
    try {
      const result=await createClient()('/auth/login',{method:'POST',body:{email,password}})
      const identity=await createClient(result.accessToken)('/me')
      if(!['author','admin'].includes(identity.user?.role))throw new Error('This account does not have access to the portal.')
      setPassword('');onLogin(result.accessToken,identity.user)
    }catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  return <main className="login-layout"><section className="login-story"><a className="brand" href="#"><Icon name="leaf" size={32}/><span>BookLeaf<small>PUBLISHING</small></span></a><div className="login-story-content"><span className="banner-kicker">YOUR WORDS. OUR COMMITMENT.</span><h1>Great stories deserve<br/>great support.</h1><p>A dedicated space for your publishing journey.<br/>Your books, your conversations, your next chapter.</p><div className="login-art" aria-hidden="true"><div className="login-book"><Icon name="leaf" size={62}/><span>Every story<br/>starts with<br/>a single leaf.</span><small>BOOKLEAF PUBLISHING</small></div><div className="login-book-spine"/></div></div><p className="login-copyright">BookLeaf Publishing · India & the United States</p></section><section className="login-form-side"><form className="login-form" onSubmit={submit}><p className="eyebrow">AUTHOR & OPERATIONS PORTAL</p><h2>Welcome back.</h2><p className="subtitle">Sign in to your publishing workspace.</p>{message&&<div className="alert warning" role="status">{message}</div>}<ErrorBox message={error}/><Field label="Email address"><input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="Your account email" disabled={busy}/></Field><Field label="Password" htmlFor="login-password"><span className="password-field"><input id="login-password" aria-label="Password" type={visible?'text':'password'} autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/><button className="text-button" type="button" aria-label={visible?'Hide password':'Show password'} onClick={()=>setVisible(value=>!value)}>{visible?'Hide':'Show'}</button></span></Field><button className="button full login-submit" disabled={busy}>{busy?'Signing in…':'Sign in'}<Icon name="arrow"/></button><p className="login-help">Use the account provided by your BookLeaf team.<br/>Need access? Contact your publishing coordinator.</p><div className="login-security"><Icon name="lock" size={15}/><span>Your session stays in memory. Refreshing signs you out.</span></div></form></section></main>
}

export default function App() {
  const [session,setSession]=useState(null),[message,setMessage]=useState(''),[route,setRoute]=useState('/dashboard'),[initialBook,setInitialBook]=useState(''),[hasEdits,setHasEdits]=useState(false),[loggingOut,setLoggingOut]=useState(false)
  const [expired,setExpired]=useState(false)
  const expire=useCallback(()=>{setExpired(true);setMessage('Your session has ended. Sign in with the same account to recover your unsent work. Do not refresh the page.')},[])
  const [transport]=useState(()=>createMemoryClient(expire))
  const client=transport.request
  function signIn(token,user) {
    if(session&&(user._id!==session.user._id||user.role!==session.user.role))throw new Error('Sign in with the original account to recover this workspace, or discard it first.')
    transport.setToken(token);setSession({user});setExpired(false);setMessage('');if(!session)setRoute('/dashboard')
  }
  function discard() {
    if(hasEdits&&!window.confirm('Discard unsent work and sign out?'))return
    transport.setToken('');setSession(null);setExpired(false);setHasEdits(false);setMessage('Workspace discarded. Sign in to continue.')
  }
  useEffect(()=>{
    if(!hasEdits)return
    const warn=event=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',warn)
    return ()=>window.removeEventListener('beforeunload',warn)
  },[hasEdits])
  function navigate(next,book=null,force=false) {
    if(hasEdits&&!force&&!window.confirm('Leave this page and discard unsaved changes?'))return
    setHasEdits(false);setInitialBook(book||'');setRoute(next);window.scrollTo({top:0,behavior:'instant'})
  }
  async function logout() {
    if(loggingOut)return
    if(hasEdits&&!window.confirm('Sign out and discard unsaved changes?'))return
    setLoggingOut(true)
    let text='You’ve been signed out. All previously issued account tokens were revoked.'
    try {await client('/auth/logout',{method:'POST'})}catch{text='Signed out on this device. The server could not confirm revocation; the token may remain valid until it expires.'}
    finally {transport.setToken('');setExpired(false);setSession(null);setHasEdits(false);setMessage(text);setLoggingOut(false)}
  }
  if(!session)return <Login message={message} onLogin={signIn}/>
  const {user}=session,admin=user.role==='admin'
  let screen
  if(route==='/dashboard')screen=<Dashboard client={client} user={user} navigate={navigate}/>
  else if(route==='/books'&&!admin)screen=<Books client={client} navigate={navigate}/>
  else if(route.startsWith('/books/')&&!admin)screen=<BookDetail client={client} navigate={navigate} bookId={route.split('/')[2]}/>
  else if(route==='/tickets/new'&&!admin)screen=<CreateTicket client={client} navigate={navigate} initialBook={initialBook} onDirty={setHasEdits}/>
  else if(route==='/tickets')screen=<TicketList client={client} user={user} navigate={navigate}/>
  else if(/^\/tickets\/[a-f0-9]{24}$/i.test(route))screen=<TicketDetail key={route} client={client} user={user} ticketId={route.split('/')[2]} navigate={navigate} onDirty={setHasEdits}/>
  else screen=<div className="panel panel-pad"><h1>Page unavailable</h1><button className="button" onClick={()=>navigate('/dashboard')}>Back to overview</button></div>
  const items=[['/dashboard',admin?'Overview':'Dashboard','grid'],...(!admin?[['/books','My books','book']]:[]),['/tickets',admin?'Ticket queue':'My tickets','ticket']]
  return <>{expired&&<><Login message={message} onLogin={signIn}/><button className="button secondary" onClick={discard}>Discard workspace and sign out</button></>}<div hidden={expired}><div className="app-layout"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar"><button className="brand" onClick={()=>navigate('/dashboard')}><Icon name="leaf" size={30}/><span>BookLeaf<small>PUBLISHING</small></span></button><div className="workspace-label">{admin?'OPERATIONS':'AUTHOR WORKSPACE'}</div><nav aria-label="Main navigation">{items.map(([path,label,icon])=><button key={path} className={`nav-item ${(route===path||(path==='/tickets'&&route.startsWith('/tickets/'))||(path==='/books'&&route.startsWith('/books/')))?'active':''}`} aria-current={route===path?'page':undefined} onClick={()=>navigate(path)}><Icon name={icon}/>{label}</button>)}</nav><div className="sidebar-bottom"><Icon name="leaf" size={25}/><p>{admin?'Care behind every conversation.':'A partner in every chapter.'}</p><small>BookLeaf Support Portal</small></div></aside><div className="main-layout"><header className="topbar"><span className="portal-label"><span>{admin?'Operations portal':'Author portal'}</span><span className="topbar-dot"/><span className="portal-company">BookLeaf Publishing</span></span><div className="account"><span className="avatar">{user.email.slice(0,1).toUpperCase()}</span><span className="account-text"><strong>{user.email}</strong><small>{admin?'Administrator':'Author'}</small></span><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logout} disabled={loggingOut}><Icon name="logout"/></button></div></header><main id="main-content" tabIndex={-1} className="workspace" key={`${user._id}:${route}`}>{screen}</main><footer className="app-footer"><span>BookLeaf Publishing</span><span>Thoughtful support. Every step of the way.</span></footer></div></div></div></>
}
