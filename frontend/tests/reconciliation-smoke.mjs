// Isolated regression fixtures: every API call is intercepted; no backend or database.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
const browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
await page.clock.install()
const id=number=>String(number).padStart(24,'0')
const admin={_id:id(1),email:'admin@example.test',role:'admin'}
const original={_id:id(3),subject:'Reconciliation fixture',description:'Original server details',status:'Open',priority:'High',category:'General Inquiry',assignee:null,author:{_id:id(4),author_id:'AUTH999',name:'Fixture'},book:{_id:id(5),book_id:'BK999',title:'Verified fixture book'},createdAt:'2024-01-01T00:00:00Z',updatedAt:'2024-01-01T00:00:00Z',lastActivityAt:'2024-01-01T00:00:00Z',revision:4}
let ticket={...original},failRead=false,summaryReads=0,passed=0
const patches=[],errors=[]
const pass=name=>{passed++;console.log('PASS '+name)}
page.on('pageerror',error=>errors.push(error.message))
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
  if(path==='/api/auth/login')return send({accessToken:'isolated-fixture-token'})
  if(path==='/api/me')return send({user:admin})
  if(path==='/api/admin/tickets')return send({tickets:[ticket],pagination:{page:1,limit:10,total:1,totalPages:1}})
  if(path.endsWith('/messages')||path.endsWith('/notes'))return send({[path.endsWith('/notes')?'notes':'messages']:[],pagination:{limit:10,hasMore:false,nextCursor:null}})
  if(path==='/api/admin/tickets/'+ticket._id) {
    if(request.method()==='PATCH') {
      const body=request.postDataJSON(),revision=request.headers()['if-match']
      patches.push({body,revision})
      if(revision!==JSON.stringify(String(ticket.revision)))return send({error:'Ticket changed; refresh and reconcile your edits'},409)
      ticket={...ticket,...body,revision:ticket.revision+1}
      // Match the real service: write DTOs may contain unpopulated references.
      return send({ticket:{...ticket,author:ticket.author._id,book:ticket.book._id}})
    }
    summaryReads++
    if(failRead)return send({error:'Fixture temporarily unavailable'},503)
    return send({ticket})
  }
  return send({error:'Unexpected fixture route'},404)
})
const field=name=>page.getByLabel(name,{exact:true})
const save=()=>page.getByRole('button',{name:'Save changes',exact:true})
const reset=()=>page.getByRole('button',{name:'Reset edits',exact:true}).click()
const reload=()=>page.getByRole('button',{name:'Load current details to reconcile',exact:true}).click()
async function assertFields(expected) {
  for(const key of ['status','priority','category','assignee'])assert.equal(await field(key[0].toUpperCase()+key.slice(1)).inputValue(),expected[key]??'',key)
}
async function editAll() {
  await field('Status').selectOption('Open')
  await field('Priority').selectOption('Critical')
  await field('Category').selectOption('ISBN & Metadata Issues')
  await page.getByRole('button',{name:'Assign to me',exact:true}).click()
}
async function assertDrafts(reply='Unsent public reply',note='Unsent private note') {
  assert.equal(await field('Your message').inputValue(),reply)
  assert.equal(await field('New internal note').inputValue(),note)
}
try {
  await page.goto(process.env.UI_TEST_URL||'http://127.0.0.1:5173')
  await field('Email address').fill(admin.email)
  await field('Password').fill(randomBytes(16).toString('hex'))
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('button',{name:'Ticket queue',exact:true}).click()
  await page.getByRole('button',{name:ticket.subject,exact:true}).click()
  await field('Priority').waitFor()
  await assertFields(original)
  await field('Your message').fill('Unsent public reply')
  await field('New internal note').fill('Unsent private note')
  await editAll()
  ticket={...ticket,subject:'Accepted newer server details',description:'Newer description',status:'In Progress',priority:'Low',category:'Printing & Quality',assignee:id(2),revision:5}
  await save().click()
  await page.getByRole('button',{name:'Load current details to reconcile',exact:true}).waitFor()
  assert.equal(patches.length,1);assert.equal(patches[0].revision,'"4"')
  await assertFields({status:'Open',priority:'Critical',category:'ISBN & Metadata Issues',assignee:admin._id})
  await assertDrafts();assert.equal(await save().isDisabled(),true)
  pass('409 preserves every local management field and both drafts; no automatic retry')

  failRead=true;await reload()
  await page.getByText('Fixture temporarily unavailable',{exact:true}).waitFor()
  await page.getByText(/Accepted server revision 4\./).waitFor()
  await assertDrafts();assert.equal(await field('Priority').inputValue(),'Critical')
  assert.equal(await save().isDisabled(),true)
  failRead=false;await reset()
  await assertFields(original);await assertDrafts()
  assert.equal(await save().isDisabled(),true);assert.equal(patches.length,1)
  pass('failed reconciliation and Reset cannot dismiss a known conflict or resubmit the stale revision')

  await editAll();await reload()
  await page.getByText(/Accepted server revision 5\. Current saved values: In Progress; Low/).waitFor()
  await page.getByRole('heading',{name:'Accepted newer server details',exact:true}).waitFor()
  await page.getByText('Newer description',{exact:true}).waitFor()
  await assertFields({status:'Open',priority:'Critical',category:'ISBN & Metadata Issues',assignee:admin._id})
  await assertDrafts()
  const accepted={...ticket}
  await reset()
  await assertFields(accepted);await assertDrafts()
  assert.equal(await field('Priority').inputValue(),'Low','Reset must use accepted Low, not the original High prop')
  await page.getByText(/Accepted server revision 5\./).waitFor()
  assert.equal(patches.length,1)
  pass('explicit reconciliation updates details and revision together; Reset restores all accepted fields, including Low instead of High')

  await field('Priority').selectOption('Medium');await save().click()
  await page.getByText('Changes saved.',{exact:true}).waitFor()
  assert.deepEqual(patches.at(-1),{body:{priority:'Medium'},revision:'"5"'})
  await page.getByText(/Accepted server revision 6\./).waitFor()
  await page.locator('.ticket-meta').getByText('Verified fixture book',{exact:true}).waitFor()
  await page.locator('.ticket-meta').getByText('Author: Fixture · AUTH999',{exact:true}).waitFor()
  await field('Priority').selectOption('High');await reset()
  assert.equal(await field('Priority').inputValue(),'Medium');await assertDrafts()
  pass('saving uses the accepted If-Match token; confirmed saves become the next Reset baseline')

  await field('Your message').fill('');await field('New internal note').fill('')
  await page.locator('.poll-status').filter({hasText:'Checks for updates every 20 seconds.'}).waitFor()
  ticket={...ticket,subject:'Unaccepted background details',priority:'Critical',status:'Open',category:'Royalty & Payments',assignee:null,revision:7}
  await page.clock.fastForward(21000)
  await page.getByRole('button',{name:'Load current details to reconcile',exact:true}).waitFor()
  await page.getByRole('heading',{name:'Accepted newer server details',exact:true}).waitFor()
  await page.getByText(/Accepted server revision 6\./).waitFor()
  assert.equal(await field('Priority').inputValue(),'Medium')
  await field('Priority').selectOption('High')
  await field('Your message').fill('Unsent public reply');await field('New internal note').fill('Unsent private note')
  const reads=summaryReads
  await page.clock.fastForward(21000)
  await page.getByRole('button',{name:'Show latest replies',exact:true}).click()
  assert.equal(summaryReads,reads);assert.equal(await field('Priority').inputValue(),'High')
  await assertDrafts();assert.equal(await save().isDisabled(),true)
  await reset()
  assert.equal(await field('Priority').inputValue(),'Medium','Unaccepted polling data must not become the Reset baseline')
  await assertDrafts();assert.equal(await save().isDisabled(),true);assert.equal(patches.length,2)
  pass('unaccepted polling data and parent rerenders cannot overwrite local edits or advance the Reset baseline')

  await reload();await page.getByText(/Accepted server revision 7\./).waitFor()
  await page.getByRole('heading',{name:'Unaccepted background details',exact:true}).waitFor()
  await assertFields(ticket);await assertDrafts()
  await field('Priority').selectOption('Low');await save().click()
  await page.getByText(/Accepted server revision 8\./).waitFor()
  assert.deepEqual(patches.at(-1),{body:{priority:'Low'},revision:'"7"'})
  await reset();assert.equal(await field('Priority').inputValue(),'Low');await assertDrafts()
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  assert.deepEqual(errors,[])
  pass('explicit acceptance alone advances a background revision; later saves, draft preservation and mobile layout remain correct')
  console.log(`${passed} reconciliation browser checks passed; all APIs intercepted; no live database used.`)
} finally {await browser.close()}
