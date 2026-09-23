'use strict';
// Browser audit uses local web files and the real graph; no deployment is needed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/home/yerkin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(__dirname,'.artifacts');
fs.mkdirSync(artifacts,{recursive:true});
const graph=JSON.parse(fs.readFileSync(path.join(root,'out/graph.json'),'utf8'));
const origin='https://zhetysu-team.kz';
async function fixture(browser,{width=1440,height=1000,mode='normal'}={}) {
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});
 await context.route(origin+'/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/out/graph.json'){
   if(mode==='offline')return route.abort('internetdisconnected');
   if(mode==='broken')return route.fulfill({status:200,contentType:'application/json',body:'{"nodes":'});
   if(mode==='empty')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...graph,nodes:[],edges:[],top_nodes:[],clusters:[]})});
   if(mode==='numeric'||mode==='coordinates')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...graph,nodes:graph.nodes.map((n,i)=>i?n:{...n,...(mode==='numeric'?{gid:Number(n.gid)}:{x:-1,y:2})})})});
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(graph)});
  }
  if(pathname==='/api/ask')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тестовая недоступность сервиса'})});
  const filename=path.join(root,'web',pathname==='/'?'index.html':pathname.replace(/^\//,''));
  if(!filename.startsWith(path.join(root,'web')+path.sep)||!fs.existsSync(filename))return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,contentType:filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(filename)});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.waitForTimeout(900);
 return {context,page,errors};
}
async function shot(page,name){await page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});}
async function overflow(page){return page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.right>innerWidth+2&&getComputedStyle(el).position!=='absolute'}).slice(0,8).map(el=>el.tagName+'.'+el.className)}));}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/opt/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-crash-reporter'],env:{...process.env,TMPDIR:artifacts,XDG_CACHE_HOME:path.join(artifacts,'cache'),XDG_CONFIG_HOME:path.join(artifacts,'config')}});
 try {
  for(const width of [1366,320]){
   const {context,page,errors}=await fixture(browser,{width,height:width===320?844:768});
   await page.waitForFunction(()=>document.querySelector('#top-body').children.length>=30);
   const gid=graph.top_nodes[0].gid;assert.equal(typeof gid,'string');
   assert.equal(await page.locator('.node-id').innerText(),gid,'first client opens automatically');
   await page.locator('#queue-next').click();
   assert.equal(await page.locator('.node-id').innerText(),graph.top_nodes[1].gid);
   await page.goBack();
   assert.equal(await page.locator('.node-id').innerText(),gid,'back restores selected client');
   await page.locator('#mark-check').click();
   assert.match(await page.locator('#mark-check').innerText(),/✓/);
   await page.locator('.simulation-drawer > summary').click();
   await page.locator('#remove-count').evaluate(input=>{input.value='12';input.dispatchEvent(new Event('input',{bubbles:true}))});
   await page.waitForFunction(()=>document.querySelector('#remove-value').textContent==='12');
   const fragments=await page.locator('#sim-components').innerText();assert.match(fragments,/\d/);
   await page.reload();await page.waitForFunction(()=>document.querySelector('.node-id'));
   assert.equal(await page.locator('.node-id').innerText(),gid,'reload restores client');
   assert.match(await page.locator('#mark-check').innerText(),/✓/,'reload restores local mark');
   assert.equal(await page.locator('#remove-value').textContent(),'12','reload restores simulation');
   await page.locator('.simulation-drawer > summary').click();
   await page.locator('#simulation-reset').click();
   await page.locator('.simulation-drawer > summary').click();
   await page.locator('#gid').fill(gid);await page.locator('#search').evaluate(form=>form.requestSubmit());
   await page.waitForFunction(id=>document.querySelector('#dossier').textContent.includes(id),gid);
   await shot(page,`workflow-${width}-light`);
   const lightOverflow=await overflow(page);assert.ok(lightOverflow.body<=width+2,JSON.stringify(lightOverflow));
   await page.locator('#theme').click();await shot(page,`workflow-${width}-dark`);
   const contrast=await page.evaluate(()=>{
    function luminance(hex){const a=hex.trim().replace('#','');const rgb=(a.length===3?[...a].map(c=>c+c):a.match(/../g)).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722}
    const result={};for(const dark of [false,true]){document.body.classList.toggle('dark',dark);const css=getComputedStyle(document.body);result[dark?'dark':'light']={};for(const color of ['text','muted','accent']){const ratios=['bg','panel','panel2'].map(bg=>{const a=luminance(css.getPropertyValue('--'+color)),b=luminance(css.getPropertyValue('--'+bg));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)});result[dark?'dark':'light'][color]=Math.min(...ratios)}}return result;
   });
   for(const colors of Object.values(contrast))for(const value of Object.values(colors))assert.ok(value>=4.5,'contrast '+value);
   await page.locator('#reset').click();
   const paint=await page.evaluate(()=>{const times=[];for(let i=0;i<10;i++){const start=performance.now();graph.paint();times.push(performance.now()-start)}return {nodes:graph.visible.length,mean:times.reduce((a,b)=>a+b,0)/times.length,max:Math.max(...times)}});
   const edgeIds=new Set(graph.edges.flatMap(e=>[e.src,e.dst])),isolated=graph.nodes.find(n=>n.is_seed&&!edgeIds.has(n.gid));assert.ok(isolated,'isolated seed fixture');
   await page.locator('#gid').fill(isolated.gid);await page.locator('#search').evaluate(form=>form.requestSubmit());
   assert.equal(await page.locator('.node-id').innerText(),isolated.gid);await shot(page,`workflow-${width}-isolated`);
   for(const tab of ['top','clusters','terminal','ask','network']){
    await page.locator(`[data-tab="${tab}"]`).first().click();await page.waitForTimeout(80);
    assert.equal(await page.locator('#'+tab).isVisible(),true,tab+' visible');
   }
   await page.locator('[data-tab="ask"]').first().click();
   await page.locator('#ask-form').evaluate(form=>form.requestSubmit());
   assert.match(await page.locator('#ask-answer').innerText(),/Напишите вопрос/);
   await page.locator('#ask-question').fill('Кого проверить первым?');
   await page.locator('#ask-form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
   await page.waitForFunction(()=>!document.querySelector('#ask-submit').disabled);
   assert.match(await page.locator('#ask-answer').innerText(),/недоступна|не смог|Нет связи/);
   await page.locator('[data-tab="network"]').first().click();
   await page.locator('#gid').fill('999999999999999999');await page.locator('#search').evaluate(form=>form.requestSubmit());
   assert.match(await page.locator('#message').innerText(),/не найден|нет|отсутств/i);
   await page.locator('#zoom-in').evaluate(button=>{for(let i=0;i<40;i++)button.click()});
   await page.locator('#zoom-out').evaluate(button=>{for(let i=0;i<80;i++)button.click()});
   await page.locator('#fit').click();await page.waitForTimeout(200);
   assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:width,errors,overflow:lightOverflow,contrast,paint}));await context.close();
  }
  for(const mode of ['broken','offline','empty','numeric','coordinates']){
   const {context,page,errors}=await fixture(browser,{mode});await shot(page,`workflow-${mode}`);
   const message=await page.locator('#message').innerText();assert.ok(message.trim(),mode+' must explain its state');
   assert.deepEqual(errors,[]);console.log(JSON.stringify({mode,message,errors}));await context.close();
  }
  for(const api of ['success','empty','malformed']){
   const {context,page,errors}=await fixture(browser);
   await context.route(origin+'/api/ask',route=>route.fulfill({status:200,contentType:'application/json',body:api==='malformed'?'oops':JSON.stringify({answer:api==='empty'?'':'<img src=x onerror="window.injected=true"> Проверить признаки',nodes:[graph.top_nodes[0].gid]})}));
   await page.locator('[data-tab="ask"]').first().click();await page.locator('#ask-question').fill('Кого проверить?');await page.locator('#ask-submit').click();await page.waitForFunction(()=>!document.querySelector('#ask-submit').disabled);
   const answer=await page.locator('#ask-answer').innerText();
   if(api==='success'){assert.match(answer,/<img/);assert.equal(await page.locator('#ask-answer img').count(),0);await page.locator('.ask-client').click();assert.equal(await page.locator('.node-id').innerText(),graph.top_nodes[0].gid)}
   else assert.match(answer,api==='empty'?/не найден ответ/:/нечитаемый ответ/);
   assert.deepEqual(errors,[]);console.log(JSON.stringify({api,answer}));await context.close();
  }
  const liveContext=await browser.newContext(),live=await liveContext.newPage(),liveErrors=[];live.on('pageerror',e=>liveErrors.push(e.message));
  await live.goto(origin);await live.waitForSelector('.node-id');await live.locator('[data-tab="ask"]').first().click();await live.locator('#ask-question').fill('кого смотреть первым');
  const responsePromise=live.waitForResponse(r=>r.url().endsWith('/api/ask')&&r.request().method()==='POST',{timeout:40000});await live.locator('#ask-submit').click();const response=await responsePromise;assert.equal(response.status(),200);const payload=await response.json();
  await live.waitForSelector('.ask-client');const target=await live.locator('.ask-client').first().getAttribute('data-gid');await live.locator('.ask-client').first().click();assert.equal(await live.locator('.node-id').innerText(),target);assert.deepEqual(liveErrors,[]);console.log(JSON.stringify({live:true,status:response.status(),target,answer:payload.answer.slice(0,350),errors:liveErrors}));await liveContext.close();
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
