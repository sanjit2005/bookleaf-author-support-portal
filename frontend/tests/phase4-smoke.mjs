// Offline browser fixtures only. No running backend, Atlas, or AI provider.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
const browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
await page.clock.install()
const id=number=>String(number).padStart(24,'0')
const admin={_id:id(1),email:'admin@example.test',role:'admin'},author={_id:id(2),email:'author@example.test',role:'author'}
let ticket={_id:id(3),subject:'Phase four fixture',description:'Offline workflow',status:'Open',priority:'Medium',category:null,assignee:null,author:{_id:id(4),author_id:'AUTH999',name:'Fixture'},book:null,createdAt:'2024-01-01T00:00:00Z',updatedAt:'2024-01-01T00:00:00Z',lastActivityAt:'2024-01-01T00:00:00Z',revision:0,classification:{state:'failed',errorCode:'PROVIDER_ERROR',suggestedCategory:null,suggestedPriority:null,manuallyReviewed:false,needsManualReview:true}}
let total=25,expireWrite=false,failWrite=false,sequence=0
const messages=[],notes=[],patches=[],creates=[],queueRequests=[],errors=[]
let passed=0
const pass=name=>{passed++;console.log('PASS '+name)}
page.on('pageerror',error=>errors.push(error.message))
const reviewed=new Set()
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method()
  const role=request.headers().authorization?.endsWith('author')?'author':'admin'
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
  if(path==='/api/auth/login')return send({accessToken:'fixture-'+(request.postDataJSON().email===author.email?'author':'admin')})
  if(path==='/api/me')return send({user:role==='admin'?admin:author})
  if(path==='/api/auth/logout')return send({message:'Signed out'})
  if(path==='/api/me/books')return send({books:[],pagination:{page:1,limit:50,total:0,totalPages:0}})
  if(/^\/api\/(me|admin)\/tickets$/.test(path)) {
    if(method==='POST'){creates.push(request.postDataJSON());return send({ticket},201)}
    const number=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||10)
    if(role==='admin')queueRequests.push(url.search)
    return send({tickets:number<=Math.ceil(total/limit)?[ticket]:[],pagination:{page:number,limit,total,totalPages:Math.ceil(total/limit)}})
  }
  if(path.endsWith('/draft'))return send({draft:'Editable AI fixture draft. Verify the facts before sending.',requiresReview:true,contextWarnings:[]})
  if(path.endsWith('/messages')||path.endsWith('/notes')) {
    const key=path.endsWith('/notes')?'notes':'messages',items=key==='notes'?notes:messages
    if(method==='GET')return send({[key]:items,pagination:{limit:10,hasMore:false,nextCursor:null}})
    if(expireWrite){expireWrite=false;return send({error:'Authentication required'},401)}
    if(failWrite){failWrite=false;return route.abort('failed')}
    const saved={_id:id(100+(++sequence)),body:request.postDataJSON().body,createdAt:new Date().toISOString(),sender:admin,createdBy:admin}
    items.unshift(saved);ticket={...ticket,revision:ticket.revision+1,updatedAt:new Date().toISOString()}
    return send({[key==='notes'?'note':'message']:saved},201)
  }
  if(/^\/api\/(me|admin)\/tickets\/[a-f0-9]+$/.test(path)) {
    if(method==='PATCH') {
      const revision=request.headers()['if-match'],body=request.postDataJSON();patches.push({revision,body})
      if(revision!==JSON.stringify(String(ticket.revision)))return send({error:'Ticket changed; refresh and reconcile your edits'},409)
      for(const field of ['category','priority'])if(Object.hasOwn(body,field))reviewed.add(field)
      const manuallyReviewed=reviewed.size===2
      ticket={...ticket,...body,revision:ticket.revision+1,classification:{...ticket.classification,manuallyReviewed,needsManualReview:!manuallyReviewed},updatedAt:new Date().toISOString()}
    }
    return send({ticket})
  }
  return send({error:'Unexpected fixture route'},404)
})
async function signIn(user) {
  await page.getByLabel('Email address').fill(user.email)
  await page.getByLabel('Password',{exact:true}).fill(randomBytes(16).toString('hex'))
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
}
async function queue() {await page.getByRole('button',{name:'Ticket queue',exact:true}).click();await page.getByRole('heading',{name:'Ticket queue',exact:true}).waitFor()}
async function detail() {await queue();await page.getByRole('button',{name:ticket.subject,exact:true}).click();await page.getByRole('heading',{name:'Ticket management'}).waitFor()}
try {
  await page.goto(process.env.UI_TEST_URL||'http://127.0.0.1:5173')
  await signIn(author)
  await page.getByRole('button',{name:'Start a conversation',exact:true}).first().click()
  const picker=page.getByLabel('Attachments (optional · selection only)',{exact:true})
  await picker.setInputFiles({name:'local-only.txt',mimeType:'text/plain',buffer:Buffer.from('Never uploaded')})
  await page.getByText('1 file(s) selected locally only. This ticket will be submitted without attachments.',{exact:true}).waitFor()
  assert.match(await picker.getAttribute('aria-describedby'),/.+-hint/)
  assert.equal(await picker.getAttribute('accept'),null)
  await page.getByLabel('Subject',{exact:true}).fill('Offline selection fixture')
  await page.getByLabel('Tell us more').fill('No attachment is submitted.')
  await page.getByRole('button',{name:'Submit support ticket'}).click()
  await page.getByRole('heading',{name:ticket.subject,exact:true}).waitFor()
  assert.deepEqual(Object.keys(creates[0]).sort(),['book_id','category','description','subject'])
  assert.equal(JSON.stringify(creates).includes('local-only'),false)
  pass('accessible attachment selection is explicitly local only and never enters the API payload')
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await signIn(admin)
  await detail()
  await page.getByText('AI failure: PROVIDER_ERROR',{exact:true}).waitFor()
  await page.getByLabel('Category',{exact:true}).selectOption('General Inquiry')
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await page.getByText('Changes saved.',{exact:true}).waitFor()
  assert.equal(ticket.classification.needsManualReview,true)
  await page.getByLabel('Priority',{exact:true}).selectOption('High')
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await page.getByText('Category and priority manually reviewed by an admin. This does not validate the original AI result.',{exact:true}).waitFor()
  assert.equal(ticket.classification.state,'failed');assert.equal(ticket.classification.errorCode,'PROVIDER_ERROR')
  pass('manual review completes only after both admin corrections and preserves original AI failure information')
  const before=ticket.revision
  await page.getByLabel('Status',{exact:true}).selectOption('In Progress')
  await page.getByLabel('Priority',{exact:true}).selectOption('Critical')
  await page.getByLabel('Category',{exact:true}).selectOption('Printing & Quality')
  await page.getByRole('button',{name:'Assign to me'}).click()
  ticket={...ticket,priority:'Low',revision:before+1}
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await page.getByRole('button',{name:'Load current details to reconcile'}).waitFor()
  assert.equal(ticket.priority,'Low');assert.equal(await page.getByLabel('Priority',{exact:true}).inputValue(),'Critical')
  assert.equal(await page.getByRole('button',{name:'Save changes',exact:true}).isDisabled(),true)
  await page.getByRole('button',{name:'Load current details to reconcile'}).click()
  await page.getByText(/Current saved values: Open; Low/).waitFor()
  assert.equal(await page.getByLabel('Assignee',{exact:true}).inputValue(),admin._id)
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await page.getByText('Changes saved.',{exact:true}).waitFor()
  assert.equal(patches.at(-1).revision,JSON.stringify(String(before+1)))
  assert.deepEqual(patches.at(-1).body,{status:'In Progress',priority:'Critical',category:'Printing & Quality',assignee:admin._id})
  pass('stale multi-field updates cannot save until explicit refresh/reconciliation; exact inputs are preserved')
  const draft=page.getByLabel('Editable AI draft · review before sending',{exact:true})
  await draft.fill('AI draft edited locally, still unsent.')
  await page.getByLabel('New internal note').fill('Unsent private note survives expiry.')
  await page.getByLabel('Priority',{exact:true}).selectOption('Medium')
  failWrite=true
  await page.getByRole('button',{name:'Save private note'}).click()
  await page.getByText(/connection was interrupted/).waitFor()
  assert.equal(await page.getByLabel('New internal note').inputValue(),'Unsent private note survives expiry.')
  await page.getByText('I have reviewed the facts, policy and commitments in this draft.').click()
  expireWrite=true
  await page.getByRole('button',{name:'Send reply',exact:true}).click()
  await page.getByRole('heading',{name:'Welcome back.'}).waitFor()
  assert.equal(messages.length,0);assert.equal(notes.length,0)
  await signIn(author)
  await page.getByText(/Sign in with the original account to recover/).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Ticket management'}).count(),0)
  await signIn(admin)
  await page.getByRole('heading',{name:'Ticket management'}).waitFor()
  assert.equal(await draft.inputValue(),'AI draft edited locally, still unsent.')
  assert.equal(await page.getByLabel('New internal note').inputValue(),'Unsent private note survives expiry.')
  assert.equal(await page.getByLabel('Priority',{exact:true}).inputValue(),'Medium')
  assert.equal(await page.getByRole('checkbox').isChecked(),true)
  assert.equal(messages.length,0);assert.equal(notes.length,0)
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0)
  pass('failed writes and expired sessions preserve AI edits, notes, review confirmation and management inputs; another account cannot resume')
  await page.getByRole('button',{name:'Reset edits'}).click()
  await page.getByRole('button',{name:'Save private note'}).click()
  await page.getByText('Internal note saved. Only admins can see it.',{exact:true}).waitFor()
  assert.equal(await draft.inputValue(),'AI draft edited locally, still unsent.')
  await page.getByLabel('Priority',{exact:true}).selectOption('Low')
  await page.getByRole('button',{name:'Send reply',exact:true}).click()
  await page.getByText('Your public reply was sent.',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('Priority',{exact:true}).inputValue(),'Low')
  pass('reply/note activity and detail refreshes do not remount management or erase other unsent work')
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  pass('conflict, review and draft controls fit a narrow mobile viewport')
  await page.getByRole('button',{name:'Reset edits'}).click();await queue()
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 2 of 3 · 25 results').waitFor()
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 3 of 3 · 25 results').waitFor()
  total=14;await page.clock.fastForward(21000)
  await page.getByText('Page 2 of 2 · 14 results').waitFor()
  assert.equal(new URLSearchParams(queueRequests.at(-1)).get('page'),'2')
  total=4;await Promise.all([page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/admin/tickets'&&url.searchParams.get('page')==='1'}),page.clock.fastForward(21000)])
  await page.getByText('4 tickets · updates every 20s').waitFor()
  assert.equal(new URLSearchParams(queueRequests.at(-1)).get('page'),'1')
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).count(),0)
  total=0;await page.getByRole('button',{name:'Refresh',exact:true}).click()
  await page.getByRole('heading',{name:'No tickets to show',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).count(),0)
  pass('polling recovers out-of-range queue pages to the last available page, including a single-page queue')
  total=25;await page.getByRole('button',{name:'Refresh',exact:true}).click()
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 2 of 3 · 25 results').waitFor()
  await page.getByLabel('Status',{exact:true}).selectOption('Open')
  await page.getByLabel('Created from (UTC)',{exact:true}).fill('2024-01-01')
  await page.getByRole('button',{name:'Apply filters'}).click();await page.getByText('Page 1 of 3 · 25 results').waitFor()
  const query=new URLSearchParams(queueRequests.at(-1));assert.equal(query.get('page'),'1');assert.equal(query.get('status'),'Open');assert.equal(query.get('startDate'),'2024-01-01');assert.equal(query.get('sort'),'urgency')
  pass('filter changes reset pagination without losing Phase 1 dates, status or global urgency ordering')
  assert.deepEqual(errors,[])
  pass('no browser runtime errors')
  console.log(`${passed} Phase 4 browser checks passed; every API request intercepted; no live integration claims.`)
}finally {await browser.close()}
