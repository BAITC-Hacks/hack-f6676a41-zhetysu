'use strict';
// Optional real-browser check. Set PLAYWRIGHT_MODULE and CHROMIUM_PATH to installed tools.
// Browser profiles, caches and screenshots are confined to this project's .artifacts.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const dir=path.resolve(__dirname,'.artifacts');fs.mkdirSync(dir,{recursive:true});
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,args:['--no-sandbox','--disable-crash-reporter'],env:{...process.env,TMPDIR:dir,XDG_CACHE_HOME:path.join(dir,'cache'),XDG_CONFIG_HOME:path.join(dir,'config')}});
 try{
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:2*1024*1024,uploadThroughput:1024*1024});
 await page.addInitScript(()=>{window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true})});
 const start=Date.now();await page.goto('https://zhetysu-team.kz/');await page.waitForFunction(()=>document.querySelector('#message')?.textContent.includes('Данные загружены'));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const loadedMs=Date.now()-start;assert.equal(await page.locator('#stub').isVisible(),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(dir,'mobile-network.png')});
 await page.locator('[data-tab="terminal"]').click();await page.locator('#terminal').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('#terminal tbody tr').count(),444);
 await page.screenshot({path:path.join(dir,'mobile-terminal.png')});
 await page.locator('#theme').click();await page.locator('#terminal').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(dir,'mobile-terminal-dark.png')});
 const firstId=await page.locator('#terminal tbody button').first().innerText();const searchStart=Date.now();await page.locator('#terminal tbody button').first().click();await page.waitForFunction(id=>document.querySelector('#dossier h2').textContent.includes(id),firstId);const searchMs=Date.now()-searchStart;
 await page.locator('#remove-count').evaluate(el=>{el.value='50';el.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitForFunction(()=>document.querySelector('#remove-value').textContent==='50');
 assert.ok((await page.locator('#simulation-result').innerText()).includes('193'));
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-tab="terminal"]').click();await page.locator('#theme').click();await page.screenshot({path:path.join(dir,'desktop-terminal.png')});
 console.log(JSON.stringify({loadedMs,searchMs,network:'80ms latency, 2 MiB/s download, CPU slowdown 4x',graph:await page.locator('#visible-count').innerText(),longTasks:await page.evaluate(()=>window.longTasks),errors},null,2));assert.equal(errors.length,0);
 }finally{await context.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
