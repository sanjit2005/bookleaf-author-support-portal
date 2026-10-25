// Optional browser verification: isolated HTTP fixtures only, never a real backend.
// Uses an externally available Playwright module; no credentials or persistent tokens.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
const browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true})
let passed=0
function pass(name){passed++;console.log('PASS '+name)}
const user={_id:'111111111111111111111111',email:'author@example.test',role:'author'}
const admin={_id:'222222222222222222222222',email:'admin@example.test',role:'admin'}
const category='Royalty & Payments',author={_id:'333333333333333333333333',name:'Fixture author',author_id:'AUTH999'}
const book={book_id:'BK999',title:'A Fixture Publishing Journey',genre:'Fiction',isbn:'PLACEHOLDER-ISBN',status:'Published & Live',publication_date:'2024-02-29',mrp:'399',author_royalty_per_copy:'35',total_copies_sold:2,total_royalty_earned:'70',royalty_paid:'0',royalty_pending:'70',last_royalty_payout_date:null,print_partner:'In-House',available_on:['BookLeaf Store']}
let ticket={revision:0,_id:'444444444444444444444444',subject:'A fixture royalty question',description:'Please explain the payout cycle.',status:'Open',priority:'High',category,author,book:{...book,_id:'555555555555555555555555'},assignee:null,createdAt:'2024-01-01T00:00:00Z',updatedAt:'2024-01-01T00:00:00Z',lastActivityAt:'2024-01-01T00:00:00Z',resolvedAt:null,closedAt:null}
const messages=[],notes=[],writes=[]
let aiUnavailable=false,expireNext=false,detailReads=0,lastQueuePriority='',loginFailure=null
const queueQueries=[]
const page=await browser.newPage({viewport:{width:1440,height:1000}})
await page.clock.install()
const errors=[];page.on('pageerror',error=>errors.push(error.message))
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method()
  const role=request.headers().authorization?.endsWith('admin')?'admin':'author'
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
  const meta=(total,limit=10)=>({page:1,limit,total,totalPages:total?1:0})
  if(path==='/api/auth/login'){
    if(loginFailure==='reset')return route.abort('connectionreset')
    if(loginFailure)return send({error:'Synthetic authentication service failure'},loginFailure)
    return send({accessToken:'fixture-'+(request.postDataJSON().email===admin.email?'admin':'author'),user:{role:'ignored'},tokenType:'Bearer',expiresIn:900})
  }
  if(path==='/api/me')return send({user:role==='admin'?admin:user})
  if(path==='/api/auth/logout'){writes.push('logout');return send({message:'All existing access tokens revoked'})}
  if(expireNext&&path==='/api/me/books')return send({error:'Authentication required'},401)
  if(path==='/api/me/books')return send({books:[book],pagination:meta(1,Number(url.searchParams.get('limit')||10))})
  if(path==='/api/me/books/BK999')return send({book})
  if(/^\/api\/(me|admin)\/tickets$/.test(path)){
    if(method==='POST'){
      writes.push('create');ticket={...ticket,...request.postDataJSON(),_id:'666666666666666666666666',status:'Open'};return send({ticket},201)
    }
    const list=!url.searchParams.get('status')||url.searchParams.get('status')===ticket.status?[ticket]:[]
    if(role==='admin'){lastQueuePriority=url.searchParams.get('priority')||'';queueQueries.push(url.search)}
    return send({tickets:list,pagination:meta(list.length,Number(url.searchParams.get('limit')||10))})
  }
  if(path.endsWith('/draft'))return aiUnavailable?send({error:'AI draft unavailable'},503):send({draft:'Thank you for your question. Please confirm the quarter you would like us to investigate.',requiresReview:true,contextWarnings:['DESCRIPTION_TRUNCATED']})
  if((path.endsWith('/messages')||path.endsWith('/notes'))&&method==='GET') {
    const key=path.endsWith('/notes')?'notes':'messages',items=[...(key==='notes'?notes:messages)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b._id.localeCompare(a._id))
    return send({[key]:items,pagination:{limit:10,hasMore:false,nextCursor:null}})
  }
  if(path.endsWith('/messages')&&method==='POST'){
    writes.push('message');messages.push({_id:randomBytes(12).toString('hex'),body:request.postDataJSON().body,sender:role==='admin'?admin:user,createdAt:new Date().toISOString(),sentAt:new Date().toISOString()});return send({message:messages.at(-1)},201)
  }
  if(path.endsWith('/notes')&&method==='POST'){
    writes.push('note');notes.push({_id:randomBytes(12).toString('hex'),body:request.postDataJSON().body,createdAt:new Date().toISOString()});return send({note:notes.at(-1)},201)
  }
  if(/^\/api\/(me|admin)\/tickets\/[a-f0-9]+$/.test(path)){
    if(method==='PATCH'){assert.equal(request.headers()['if-match'],JSON.stringify(String(ticket.revision)));writes.push('patch');ticket={...ticket,...request.postDataJSON(),revision:ticket.revision+1,updatedAt:new Date().toISOString()};return send({ticket})}
    detailReads++;return send({ticket,messages,pagination:meta(messages.length),...(role==='admin'?{notes,notesPagination:meta(notes.length)}:{})})
  }
  return send({error:'Fixture endpoint not found'},404)
})
async function login(identity){await page.getByLabel('Email address').fill(identity.email);await page.getByLabel('Password',{exact:true}).fill(randomBytes(16).toString('hex'));await page.getByRole('button',{name:'Sign in',exact:true}).click()}
try {
  await page.goto(process.env.UI_TEST_URL||'http://127.0.0.1:5173')
  await page.screenshot({path:join(tmpdir(),'bookleaf-login-ui.png'),fullPage:true})
  for(const [failure,message] of [[401,'The email or password was not accepted. Check your credentials and try again.'],[500,'The server could not complete the request. Please try again shortly.'],[503,'Support service is temporarily unavailable. Please try again shortly.'],['reset','Cannot reach the server. Check your connection and retry.']]){
    loginFailure=failure
    await login(user);await page.getByText(message,{exact:true}).waitFor()
    assert.equal(await page.getByRole('heading',{name:'Welcome back.'}).count(),1)
    assert.equal(await page.getByLabel('Password',{exact:true}).inputValue().then(value=>value.length>0),true)
    pass(`login ${failure} is reported accurately without discarding input`)
  }
  loginFailure=null
  await login(user)
  await page.getByRole('heading',{name:'A new chapter starts here.'}).waitFor()
  await page.getByText('Actual records from your current workspace').waitFor()
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);pass('author login uses /me and no persistent storage')
  await page.getByRole('button',{name:'My books',exact:true}).click();await page.getByText(book.title,{exact:true}).first().waitFor()
  await page.getByRole('button',{name:/View book details/}).click();await page.getByRole('heading',{name:'Sales & royalties'}).waitFor();await page.getByText('29 Feb 2024').waitFor();pass('book list, detail and date-only display')
  await page.getByRole('button',{name:'Ask about this book'}).click();await page.getByLabel('Subject',{exact:true}).fill('Fixture request from UI');await page.getByLabel('Tell us more').fill('This is isolated browser test data, never sent to a database.')
  await page.getByRole('button',{name:'Submit support ticket'}).click();await page.getByRole('heading',{name:'Fixture request from UI',exact:true}).waitFor();assert.equal(writes.filter(x=>x==='create').length,1);pass('ticket creation and navigation without duplicate submissions')
  assert.equal(await page.getByText('Internal notes',{exact:true}).count(),0)
  await page.getByLabel('Your message').fill('Fixture author reply');await page.getByRole('button',{name:'Send reply'}).click();await page.getByText('Your public reply was sent.').waitFor();pass('author public reply and private-note UI isolation')
  await page.getByRole('button',{name:'My tickets',exact:true}).click();await page.getByRole('heading',{name:'My tickets',exact:true}).waitFor();assert.equal(await page.getByLabel('Created from (UTC)',{exact:true}).count(),0);assert.equal(await page.getByLabel('Queue order').count(),0);pass('author queue has no admin date or ordering controls')
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(element=>element.getBoundingClientRect().right>window.innerWidth+1).slice(0,12).map(element=>({tag:element.tagName,cls:String(element.className),right:element.getBoundingClientRect().right})))));await page.screenshot({path:join(tmpdir(),'bookleaf-mobile-ui.png'),fullPage:true});pass('390px responsive layout has no page overflow')
  await page.getByRole('button',{name:'Sign out'}).click();await page.getByRole('heading',{name:'Welcome back.'}).waitFor();assert.ok(writes.includes('logout'));pass('logout calls revocation endpoint and returns to login')
  await page.setViewportSize({width:1440,height:1000});await login(admin);await page.getByRole('heading',{name:'Overview',exact:true}).waitFor()
  await page.getByText('Actual records from your current workspace').waitFor();assert.ok(queueQueries.some(query=>{const params=new URLSearchParams(query);return params.get('limit')==='5'&&params.get('sort')==='newest'}));pass('admin overview preserves newest conversations independently of queue ordering')
  await page.getByRole('button',{name:'Ticket queue',exact:true}).click();await page.getByLabel('Priority',{exact:true}).selectOption('High');await page.getByRole('button',{name:'Apply filters'}).click();await page.getByRole('button',{name:'Fixture request from UI',exact:true}).waitFor();assert.equal(lastQueuePriority,'High');pass('queue filter is sent to the backend')
  await page.getByLabel('Created from (UTC)',{exact:true}).fill('2024-01-01');await page.getByLabel('Created through (UTC)',{exact:true}).fill('2024-01-31');
  await Promise.all([page.waitForRequest(request=>{const url=new URL(request.url());return url.pathname==='/api/admin/tickets'&&url.searchParams.get('startDate')==='2024-01-01'&&url.searchParams.get('endDate')==='2024-01-31'&&url.searchParams.get('priority')==='High'&&url.searchParams.get('sort')==='urgency'&&url.searchParams.get('page')==='1'}),page.getByRole('button',{name:'Apply filters'}).click()]);pass('admin UTC dates combine with existing filters and global urgency on page one')
  await page.getByLabel('Created from (UTC)',{exact:true}).fill('2024-02-01');const beforeInvalid=queueQueries.length;await page.getByRole('button',{name:'Apply filters'}).click();await page.getByText('The start date must be on or before the end date.',{exact:true}).waitFor();assert.equal(queueQueries.length,beforeInvalid);pass('reversed dates show validation without sending a request')
  await Promise.all([page.waitForRequest(request=>{const url=new URL(request.url());return url.pathname==='/api/admin/tickets'&&!url.searchParams.has('startDate')&&!url.searchParams.has('endDate')&&!url.searchParams.has('priority')}),page.getByRole('button',{name:'Clear',exact:true}).click()]);
  for(const sort of ['newest','oldest','urgency'])await Promise.all([page.waitForRequest(request=>{const url=new URL(request.url());return url.pathname==='/api/admin/tickets'&&url.searchParams.get('sort')===sort&&url.searchParams.get('page')==='1'}),page.getByLabel('Queue order').selectOption(sort)]);pass('clear resets dates and every queue order is requested from the server')
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);pass('admin queue date filters fit mobile width');await page.setViewportSize({width:1440,height:1000})
  await page.getByRole('button',{name:'Fixture request from UI',exact:true}).click();await page.getByRole('heading',{name:'Ticket management'}).waitFor();pass('admin role from /me opens operations queue and ticket')
  const beforeDraft=messages.length;await page.getByLabel('Editable AI draft').waitFor();await page.getByText(/Some context was unavailable or shortened/).waitFor();pass('AI context warnings are visible before admin review');assert.equal(await page.getByRole('button',{name:'Send reply'}).isDisabled(),true);assert.equal(messages.length,beforeDraft)
  const before=messages.length;await page.getByText('I have reviewed the facts, policy and commitments in this draft.').click();await page.getByRole('button',{name:'Send reply'}).click();await page.getByText('Your public reply was sent.').waitFor();assert.equal(messages.length,before+1);pass('AI draft requires explicit review and manual send')
  await page.getByLabel('New internal note').fill('Fixture private team note');await page.getByRole('button',{name:'Save private note'}).click();await page.getByText('Internal note saved. Only admins can see it.').waitFor();await page.getByText('Fixture private team note',{exact:true}).waitFor();pass('admin private note workflow')
  await page.getByRole('button',{name:'Assign to me'}).click();await page.getByLabel('Status',{exact:true}).selectOption('In Progress');await page.getByRole('button',{name:'Save changes'}).click();await page.getByText('Ticket details saved.').waitFor();assert.equal(ticket.assignee,admin._id);assert.equal(ticket.status,'In Progress');pass('admin self-assignment and status PATCH')
  aiUnavailable=true;await page.getByRole('button',{name:'Draft with AI'}).click();await page.getByText('AI drafting is unavailable right now. You can still write and send a reply manually.').waitFor();await page.getByLabel('Your message').fill('Manual fallback reply');assert.equal(await page.getByRole('button',{name:'Send reply'}).isEnabled(),true);await page.getByLabel('Your message').fill('');pass('AI failure preserves manual composer')
  await page.getByLabel('Your message').fill('Unsaved fixture draft');await page.getByText('Live updates paused while you edit.').waitFor();const pausedCount=detailReads;await page.clock.fastForward(21000);assert.equal(detailReads,pausedCount);pass('polling pauses while a message is being edited')
  await page.getByLabel('Your message').fill('');await page.getByText('Checks for updates every 20 seconds.').waitFor();await page.clock.fastForward(21000);await page.waitForFunction(()=>document.querySelector('.poll-status')?.textContent.includes('Checks for updates'));assert.ok(detailReads>pausedCount);pass('polling resumes after edits clear')
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(tmpdir(),'bookleaf-admin-ui.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);pass('admin tools and notes fit mobile width');await page.setViewportSize({width:1440,height:1000})
  await page.reload();await page.getByRole('heading',{name:'Welcome back.'}).waitFor();pass('refresh clears in-memory session')
  await login(user);await page.getByRole('heading',{name:'A new chapter starts here.'}).waitFor();expireNext=true;await page.getByRole('button',{name:'My books',exact:true}).click();await page.getByRole('heading',{name:'Welcome back.'}).waitFor();pass('protected 401 hides the expired workspace consistently')
  assert.deepEqual(errors,[]);pass('no browser runtime errors')
  console.log(`${passed} browser checks passed; all API requests intercepted; no real database used.`)
} finally {await browser.close()}
