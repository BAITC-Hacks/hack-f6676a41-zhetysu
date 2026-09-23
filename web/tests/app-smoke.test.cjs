'use strict';
// DOM wiring smoke test; algorithm correctness is checked separately against BFS.
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const original=JSON.parse(fs.readFileSync(path.resolve(root,'../out/graph.json'),'utf8'));
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
class Element{
 constructor(id){this.id=id;this.value='';this.disabled=false;this.hidden=false;this.textContent='';this.dataset={};this.handlers={};this.style={};this.options=[];this.classes=new Set();this.classList={toggle:(c,on)=>{on??=!this.classes.has(c);on?this.classes.add(c):this.classes.delete(c)},contains:c=>this.classes.has(c)};}
 set innerHTML(value){this.html=value;if(this.id==='cluster')this.options=[...value.matchAll(/value="([^"]*)"/g)].map(m=>({value:m[1]}));}
 get innerHTML(){return this.html||''}
 addEventListener(type,fn){this.handlers[type]=fn}
 setAttribute(name,value){this[name]=value}
 getBoundingClientRect(){return {width:1000,height:650,left:0,top:0}}
 getContext(){return new Proxy({},{get:(_,key)=>()=>{}})}
}
const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
const tabs=['network','top','clusters','terminal'].map(name=>{const el=new Element('tab-'+name);el.dataset.tab=name;el.classList.toggle('active',name==='network');return el});
let payload=JSON.stringify(original),frame=0;const frames=new Map();
const context={console,setTimeout,clearTimeout,setInterval:()=>0,requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame},devicePixelRatio:1,ResizeObserver:class{observe(){}},AbortController,fetch:async()=>({ok:true,text:async()=>payload}),localStorage:{getItem:()=>null,setItem(){}},getComputedStyle:()=>({getPropertyValue:()=> '#333'}),document:{hidden:false,body:new Element('body'),getElementById:id=>elements.get(id),querySelectorAll:selector=>selector==='.view'?['network','top','clusters','terminal'].map(id=>elements.get(id)):tabs,querySelector:()=>tabs.find(t=>t.classList.contains('active')),addEventListener(){}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root,'simulation.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'terminal.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),context);
const flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn())};
const run=code=>vm.runInContext(code,context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));flush();
 assert.match(elements.get('message').textContent,/Данные загружены/);
 assert.equal(elements.get('stub').hidden,original.meta.stub!==true);
 assert.ok(elements.get('terminal-content').innerHTML.includes('С учётом границы наблюдения'));
 for(const n of [original.nodes[0],original.nodes.find(n=>!n.in_deg&&!n.out_deg)]){
 run('selectNode('+JSON.stringify(n.gid)+')');flush();assert.ok(elements.get('dossier').innerHTML.includes(n.gid));
 }
 elements.get('remove-count').value=50;elements.get('remove-count').handlers.input();flush();flush();
 assert.equal(elements.get('remove-value').textContent,50);assert.ok(elements.get('simulation-result').innerHTML.includes('Отрезано'));
 elements.get('simulation-reset').onclick();flush();assert.equal(elements.get('remove-value').textContent,0);
 const fresh=JSON.parse(JSON.stringify(original));fresh.meta.stub=false;payload=JSON.stringify(fresh);
 elements.get('remove-count').value=12;run('updateSimulation()');const selected=run('selected');await run('load({quiet:true})');flush();
 assert.equal(elements.get('stub').hidden,true);assert.equal(run('selected'),selected);assert.equal(run('removalCount'),12);
 payload='{broken';await run('load()');assert.equal(elements.get('message').classList.contains('error'),true);assert.equal(run('data.nodes.length'),original.nodes.length);
 payload=JSON.stringify({...fresh,nodes:[]});await run('load()');assert.equal(elements.get('message').classList.contains('error'),true);
 run('selectNode("not-a-client")');assert.match(elements.get('message').textContent,/не найден/);
 console.log('PASS: initial load, exact gid search, isolated seed, slider/reset, automatic stub replacement preserving selection and N, malformed/empty JSON, missing gid.');
})().catch(error=>{console.error(error);process.exitCode=1});
