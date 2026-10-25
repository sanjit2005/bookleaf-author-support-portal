// Offline browser regressions. Every API request is intercepted; no provider/DB.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
const browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true})
const id=n=>String(n).padStart(24,'0')
let passed=0
async function scenario(name,mode,check,{role='admin',status='Open'}={}) {
  const page=await browser.newPage()
  await page.clock.install()
  const user={_id:id(1),email:'fixture@example.test',role}
  const ticket={_id:id(2),subject:'Draft opening fixture',description:'Synthetic query',status,priority:'Medium',category:'General Inquiry',author:{_id:id(3),author_id:'AUTH999',name:'Fixture'},book:null,assignee:null,revision:0,createdAt:'2024-01-01T00:00:00Z',lastActivityAt:'2024-01-01T00:00:00Z'}
  let calls=0,sends=0,reads=0,release,started
  const waiting=new Promise(resolve=>{started=resolve})
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname
    const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(path==='/api/auth/login')return send({accessToken:'fixture-token'})
    if(path==='/api/me')return send({user})
    if(path==='/api/auth/logout')return send({message:'Fixture signed out'})
    if(path==='/api/me/books')return send({books:[],pagination:{page:1,limit:10,total:0,totalPages:0}})
    if(/^\/api\/(admin|me)\/tickets$/.test(path))return send({tickets:[ticket],pagination:{page:1,limit:10,total:1,totalPages:1}})
    if(path.endsWith('/draft')) {
      calls++;assert.equal(role,'admin');assert.deepEqual(request.postDataJSON(),{})
      if(mode==='delay')await new Promise(resolve=>{release=resolve;started()})
      if(mode==='network')return route.abort('failed')
      if(mode===429||mode===503)return send({error:'Unavailable',code:mode===503?'TIMEOUT':'RATE_LIMIT'},mode)
      if(mode==='malformed')return send({draft:42,requiresReview:true})
      return send({draft:'Please confirm which quarter your query concerns.',requiresReview:true,contextWarnings:[]})
    }
    if(path.endsWith('/messages')||path.endsWith('/notes')) {
      const key=path.endsWith('/notes')?'notes':'messages'
      if(request.method()==='POST') {
        sends++;return send({message:{_id:id(20),body:request.postDataJSON().body,sender:user,createdAt:'2024-01-02T00:00:00Z'}},201)
      }
      return send({[key]:[],pagination:{limit:10,hasMore:false,nextCursor:null}})
    }
    if(path.endsWith('/'+ticket._id)){reads++;return send({ticket})}
    return send({error:'Unexpected fixture path'},404)
  })
  const open=async()=>{
    await page.getByRole('button',{name:role==='admin'?'Ticket queue':'My tickets',exact:true}).click()
    await page.getByRole('button',{name:ticket.subject,exact:true}).click()
    await page.getByRole('heading',{name:ticket.subject,exact:true}).waitFor()
  }
  try {
    await page.goto(process.env.UI_TEST_URL||'http://127.0.0.1:5173')
    await page.getByLabel('Email address').fill(user.email)
    await page.getByLabel('Password',{exact:true}).fill(randomBytes(16).toString('hex'))
    await page.getByRole('button',{name:'Sign in',exact:true}).click()
    await open()
    await check({page,open,calls:()=>calls,sends:()=>sends,reads:()=>reads,waiting,release:()=>release()})
    assert.deepEqual(errors,[])
    console.log('PASS '+name);passed++
  } finally {if(release)release();await page.close()}
}
const draft=page=>page.getByLabel('Editable AI draft · review before sending',{exact:true})
const message=page=>page.getByLabel('Your message',{exact:true})
const ai=page=>page.getByRole('button',{name:'Draft with AI',exact:true})
try {
  await scenario('one automatic draft despite StrictMode and rerenders; explicit review/send only','ok',async h=>{
    await draft(h.page).waitFor();assert.equal(h.calls(),1);assert.equal(h.sends(),0)
    const send=h.page.getByRole('button',{name:'Send reply',exact:true})
    assert.equal(await send.isDisabled(),true)
    await draft(h.page).fill('Reviewed and edited synthetic reply')
    await h.page.clock.fastForward(61000);assert.equal(h.calls(),1)
    await h.page.getByText('I have reviewed the facts, policy and commitments in this draft.').click()
    assert.equal(h.sends(),0)
    await send.click();await h.page.getByText('Your public reply was sent.',{exact:true}).waitFor()
    assert.equal(h.sends(),1)
    await h.page.clock.fastForward(61000);assert.equal(h.calls(),1)
  })
  await scenario('typing during initial request wins over late draft','delay',async h=>{
    await h.waiting
    await h.page.getByLabel('Priority',{exact:true}).selectOption('High')
    await message(h.page).fill('Keep my unsent public reply')
    h.release();await h.page.getByText('Your reply changed while AI was preparing a draft. Your text has been kept.',{exact:true}).waitFor()
    assert.equal(await message(h.page).inputValue(),'Keep my unsent public reply');assert.equal(h.sends(),0)
    assert.equal(await h.page.getByLabel('Priority',{exact:true}).inputValue(),'High')
    assert.equal(h.calls(),1)
  })
  await scenario('typing then clearing never resurrects stale AI text','delay',async h=>{
    await h.waiting;await message(h.page).fill('Transient local text');await message(h.page).fill('')
    h.release();await ai(h.page).waitFor()
    assert.equal(await message(h.page).inputValue(),'');assert.equal(h.calls(),1);assert.equal(h.sends(),0)
  })
  for(const mode of [429,503,'malformed','network'])await scenario('initial '+mode+' failure does not retry on polling and preserves manual handling',mode,async h=>{
    await h.page.getByText('AI drafting is unavailable right now. You can still write and send a reply manually.',{exact:true}).waitFor()
    const before=h.reads();await h.page.clock.fastForward(61000)
    await Promise.all([h.page.waitForResponse(response=>response.url().includes('view=summary')),h.page.getByRole('button',{name:'Refresh ticket details',exact:true}).click()])
    assert.ok(h.reads()>before);assert.equal(h.calls(),1)
    await message(h.page).fill('Manual response after failure')
    assert.equal(await h.page.getByRole('button',{name:'Send reply',exact:true}).isEnabled(),true)
    assert.equal(h.sends(),0)
  })
  await scenario('manual regeneration is retained and cannot replace edited text without confirmation','ok',async h=>{
    await draft(h.page).fill('Locally edited AI draft')
    h.page.once('dialog',dialog=>dialog.dismiss());await ai(h.page).click()
    assert.equal(h.calls(),1);assert.equal(await draft(h.page).inputValue(),'Locally edited AI draft')
    h.page.once('dialog',dialog=>dialog.accept());await ai(h.page).click()
    await h.page.getByText(/Draft ready/).waitFor();await draft(h.page).fill('Second reviewed local edit')
    assert.equal(h.calls(),2);assert.equal(h.sends(),0)
    await h.page.getByText('I have reviewed the facts, policy and commitments in this draft.').click()
    await draft(h.page).fill('Changed again');assert.equal(await h.page.getByRole('button',{name:'Send reply',exact:true}).isDisabled(),true)
  })
  for(const status of ['Resolved','Closed'])await scenario('no automatic draft for '+status,'ok',async h=>{
    await h.page.clock.fastForward(61000);assert.equal(h.calls(),0)
  },{status})
  await scenario('author opening never invokes AI','ok',async h=>{
    await message(h.page).waitFor();await h.page.clock.fastForward(61000);assert.equal(h.calls(),0)
  },{role:'author'})
  await scenario('leaving and deliberately reopening creates one new opening context','ok',async h=>{
    await draft(h.page).waitFor()
    h.page.once('dialog',dialog=>dialog.accept());await h.page.getByRole('button',{name:/Back to tickets$/}).click()
    await h.open();await draft(h.page).waitFor();assert.equal(h.calls(),2);assert.equal(h.sends(),0)
  })
  console.log(`${passed} draft-on-open browser checks passed; all API calls intercepted.`)
} finally {await browser.close()}
