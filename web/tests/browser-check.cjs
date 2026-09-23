'use strict';
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const dir=path.resolve(__dirname,'.artifacts');fs.mkdirSync(dir,{recursive:true});
(async()=>{const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:1440,height:1000},args:['--no-sandbox','--disable-crash-reporter'],env:{...process.env,TMPDIR:dir,XDG_CACHE_HOME:path.join(dir,'cache'),XDG_CONFIG_HOME:path.join(dir,'config')}});try{const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('https://zhetysu-team.kz/');await page.waitForTimeout(1500);await page.screenshot({path:path.join(dir,'current-review.png')});console.log(JSON.stringify({errors,title:await page.title(),status:await page.locator('#message').innerText()}));}finally{await context.close()}})().catch(e=>{console.error(e);process.exitCode=1});
