// Isolated browser regression suite. Every API request is intercepted; no Atlas access.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
const browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
await page.clock.install()
const identifier=value=>value.toString(16).padStart(24,'0')
const author={_id:identifier(1),email:'author@example.test',role:'author'},admin={_id:identifier(2),email:'admin@example.test',role:'admin'}
const ticket={_id:identifier(3),subject:'Long conversation fixture',description:'Isolated history checks',status:'Open',priority:'Medium',category:null,author:{_id:identifier(4),author_id:'AUTH999',name:'Fixture'},book:null,assignee:null,createdAt:'2024-01-01T00:00:00.000Z',updatedAt:'2024-01-01T00:00:00.000Z',lastActivityAt:'2024-01-01T00:00:00.000Z'}
const entry=(number,privateNote=false)=>({_id:identifier(number+(privateNote?1000:100)),body:(privateNote?'Private note ':'Public reply ')+number,createdAt:new Date(Date.UTC(2024,0,1,0,0,Math.floor(number/3))).toISOString(),sender:admin})
let messages=Array.from({length:31},(_,index)=>entry(index+1)),notes=Array.from({length:31},(_,index)=>entry(index+1,true))
let failOlder=false,failPost=false,failRead=false,releasePost=null,postStarted=null,posts=0,reads=0
const urls=[],errors=[]
page.on('pageerror',error=>errors.push(error.message))
let passed=0
function pass(name){passed++;console.log('PASS '+name)}
function history(items,url) {
  let records=[...items].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b._id.localeCompare(a._id))
  const before=url.searchParams.get('before'),limit=Number(url.searchParams.get('limit')||10)
  if(before){const [time,id]=JSON.parse(Buffer.from(before,'base64url').toString());records=records.filter(item=>item.createdAt<time||item.createdAt===time&&item._id<id)}
  const found=records.slice(0,limit),hasMore=records.length>limit
  return {found,pagination:{limit,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify([found.at(-1).createdAt,found.at(-1)._id])).toString('base64url'):null}}
}
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method()
  urls.push(path+url.search)
  const identity=request.headers().authorization?.endsWith('author')?author:admin
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
  if(path==='/api/auth/login')return send({accessToken:'fixture-'+(request.postDataJSON().email===author.email?'author':'admin')})
  if(path==='/api/me')return send({user:identity})
  if(path==='/api/auth/logout')return send({message:'Fixture sign-out'})
  if(path==='/api/me/books')return send({books:[],pagination:{page:1,limit:1,total:0,totalPages:0}})
  if(/^\/api\/(me|admin)\/tickets$/.test(path))return send({tickets:[ticket],pagination:{page:1,limit:10,total:1,totalPages:1}})
  if(/^\/api\/(me|admin)\/tickets\/[a-f0-9]+$/.test(path))return send({ticket})
  const privateNote=path.endsWith('/notes')
  if(path.endsWith('/messages')||privateNote) {
    if(privateNote&&identity.role!=='admin')return send({error:'Forbidden'},403)
    if(method==='GET') {
      reads++
      if(failRead)return send({error:'Temporary fixture failure'},503)
      if(failOlder&&url.searchParams.has('before')){failOlder=false;return route.abort('failed')}
      const result=history(privateNote?notes:messages,url)
      return send({[privateNote?'notes':'messages']:result.found,pagination:result.pagination})
    }
    if(method==='POST') {
      posts++
      if(failPost){failPost=false;return route.abort('failed')}
      if(postStarted){const signal=postStarted;postStarted=null;await new Promise(resolve=>{releasePost=resolve;signal()});releasePost=null}
      const saved={_id:identifier(10000+posts),body:request.postDataJSON().body,createdAt:new Date(Date.UTC(2026,0,1,0,0,posts)).toISOString(),sender:identity._id}
      ;(privateNote?notes:messages).push(saved)
      return send({[privateNote?'note':'message']:saved},201)
    }
  }
  return send({error:'Unexpected fixture route'},404)
})
async function login(identity) {
  await page.getByLabel('Email address').fill(identity.email)
  await page.getByLabel('Password',{exact:true}).fill(randomBytes(16).toString('hex'))
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('button',{name:identity.role==='admin'?'Ticket queue':'My tickets',exact:true}).click()
  await page.getByRole('button',{name:ticket.subject,exact:true}).click()
  await page.getByRole('heading',{name:ticket.subject,exact:true}).waitFor()
}
const publicView=page.getByRole('region',{name:'Public conversation',exact:true})
const privateView=page.getByRole('region',{name:'Private internal notes',exact:true})
try {
  await page.goto(process.env.UI_TEST_URL||'http://127.0.0.1:5173')
  await login(admin)
  await publicView.getByText('Public reply 31',{exact:true}).waitFor()
  assert.deepEqual(await publicView.locator('.message .prose-text').allTextContents(),Array.from({length:10},(_,index)=>'Public reply '+(31-index)))
  await privateView.getByText('Private note 31',{exact:true}).waitFor();pass('long tickets initially display the latest ten public replies and notes newest first')

  await page.getByLabel('Your message').fill('Unsent draft survives an older-history failure')
  failOlder=true;await publicView.getByRole('button',{name:'Load older replies',exact:true}).click()
  await publicView.getByRole('button',{name:'Try again',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Your message').inputValue(),'Unsent draft survives an older-history failure')
  assert.equal(await publicView.locator('.message').count(),10)
  await publicView.getByRole('button',{name:'Try again',exact:true}).click();await publicView.getByText('Public reply 12',{exact:true}).waitFor()
  assert.equal(await publicView.locator('.message').count(),20);pass('failed older-history reads preserve visible history and drafts; retry appends older entries')

  await page.getByLabel('Your message').fill('')
  await page.locator('.poll-status').filter({hasText:'Checks for updates every 20 seconds.'}).waitFor()
  messages.push(entry(32));notes.push(entry(32,true))
  await publicView.getByRole('button',{name:'Load older replies',exact:true}).focus()
  const scroll=await page.evaluate(()=>window.scrollY)
  await page.clock.fastForward(21000)
  await publicView.getByText('New replies available. Your reading position has been kept.',{exact:true}).waitFor()
  assert.equal(await publicView.locator('.message').count(),20);assert.equal(await publicView.getByText('Public reply 32',{exact:true}).count(),0)
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Load older replies')
  assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scroll)<2);pass('polling announces new replies without replacing history, scrolling or stealing focus')

  await publicView.getByRole('button',{name:'Load older replies',exact:true}).click();await publicView.getByText('Public reply 2',{exact:true}).waitFor()
  await publicView.getByRole('button',{name:'Load older replies',exact:true}).click();await publicView.getByText('Public reply 1',{exact:true}).waitFor()
  const loaded=await publicView.locator('.message .prose-text').allTextContents()
  assert.equal(loaded.length,31);assert.equal(new Set(loaded).size,31);assert.equal(await publicView.getByRole('button',{name:'Load older replies',exact:true}).isDisabled(),true)
  await publicView.getByRole('button',{name:'Show latest replies',exact:true}).click();await publicView.getByText('Public reply 32',{exact:true}).waitFor()
  assert.equal(await publicView.locator('.message').count(),10);assert.equal(await publicView.getByText('New replies available. Your reading position has been kept.',{exact:true}).count(),0)
  pass('new arrivals do not shift older cursors; complete history has no duplicates and latest view recovers')

  assert.equal(await privateView.getByText('Private note 32',{exact:true}).count(),0)
  await privateView.getByRole('button',{name:'Show latest notes',exact:true}).click();await privateView.getByText('Private note 32',{exact:true}).waitFor()
  await privateView.getByRole('button',{name:'Load older notes',exact:true}).click();await privateView.getByText('Private note 13',{exact:true}).waitFor()
  assert.equal(await privateView.locator('.internal-note').count(),20);assert.equal(await publicView.locator('.message').count(),10)
  pass('public history and internal notes have independent cursors and loading controls')

  await page.getByLabel('New internal note').fill('Unsent private draft')
  await page.getByLabel('Your message').fill('Immediately visible confirmed admin reply')
  const started=new Promise(resolve=>{postStarted=resolve})
  await page.getByRole('button',{name:'Send reply',exact:true}).click();await started
  assert.equal(await page.getByRole('button',{name:'Sending…',exact:true}).isDisabled(),true)
  await page.getByRole('button',{name:'Sending…',exact:true}).evaluate(button=>button.click());assert.equal(posts,1)
  const readsBefore=reads;releasePost()
  await publicView.getByText('Immediately visible confirmed admin reply',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('New internal note').inputValue(),'Unsent private draft');assert.equal(reads,readsBefore)
  assert.equal(await publicView.getByText('Immediately visible confirmed admin reply',{exact:true}).count(),1)
  pass('confirmed sends appear immediately from POST response while other drafts pause polling; duplicate submission is blocked')

  failPost=true;await page.getByLabel('Your message').fill('Retry only after checking latest history')
  await page.getByRole('button',{name:'Send reply',exact:true}).click();await page.getByText('The connection was interrupted. Check whether your changes were saved before resubmitting.',{exact:true}).waitFor()
  assert.equal(posts,2);assert.equal(await page.getByLabel('Your message').inputValue(),'Retry only after checking latest history')
  await publicView.getByRole('button',{name:'Show latest replies',exact:true}).click();await publicView.getByText('Immediately visible confirmed admin reply',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('Your message').inputValue(),'Retry only after checking latest history');assert.equal(posts,2)
  await page.getByRole('button',{name:'Send reply',exact:true}).click();await publicView.getByText('Retry only after checking latest history',{exact:true}).waitFor()
  assert.equal(posts,3);assert.equal(await publicView.getByText('Retry only after checking latest history',{exact:true}).count(),1)
  pass('failed writes retain exact draft text, never retry automatically, and allow inspection before manual retry')

  await page.getByLabel('New internal note').fill('');await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);pass('long conversation and independent controls fit a narrow mobile viewport')
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await login(author)
  await publicView.getByText('Retry only after checking latest history',{exact:true}).waitFor()
  assert.equal(await privateView.count(),0);assert.equal(await page.getByText('Private note 32',{exact:true}).count(),0)
  assert.equal(urls.some(url=>url.startsWith('/api/me/tickets/')&&url.includes('/notes')),false)
  await page.getByLabel('Your message').fill('Immediately visible author reply');await page.getByRole('button',{name:'Send reply',exact:true}).click();await publicView.getByText('Immediately visible author reply',{exact:true}).waitFor()
  pass('author polling uses only public endpoints and author replies appear immediately')

  await page.getByRole('button',{name:'My tickets',exact:true}).click();await page.getByRole('heading',{name:'My tickets',exact:true}).waitFor()
  messages=[];failRead=true
  await page.getByRole('button',{name:ticket.subject,exact:true}).click()
  await publicView.getByRole('button',{name:'Try again',exact:true}).waitFor()
  failRead=false
  await publicView.getByRole('button',{name:'Try again',exact:true}).click();await publicView.getByText('No public replies yet',{exact:true}).waitFor()
  assert.equal(await publicView.getByRole('button',{name:'Load older replies',exact:true}).isDisabled(),true)
  assert.deepEqual(errors,[]);pass('initial read failures recover to a useful empty state without browser runtime errors')
  console.log(`${passed} conversation browser checks passed; all API requests intercepted; no real database used.`)
} finally {releasePost?.();await browser.close()}
