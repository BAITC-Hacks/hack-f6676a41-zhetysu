'use strict';
/* Approved visual language, with an interruptible, viewport-preserving scene transition.
   Every identifier remains a string. Only observed directed edges are rendered. */
class ApprovedGraph {
 constructor(canvas, options = {}) {
  this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.options=options;
  this.nodes=new Map(); this.adj=new Map(); this.edges=[]; this.positions=new Map(); this.renderEdges=new Map();
  this.view={gid:null,mode:'focus',focusLayout:'flow',clusterId:null,direction:'all',amounts:false};
  this.camera={x:0,y:0,scale:1}; this.width=1; this.height=1; this.dpr=1;
  this.stats={visibleNodes:0,visibleEdges:0,totalNeighbors:0,hiddenNeighbors:0};
  this.removed=new Set(); this.paths=[]; this.hover=null; this.hoverEdge=null; this.destroyed=false;
  this.pointers=new Map(); this.listeners=[]; this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  this.media=matchMedia('(prefers-reduced-motion: reduce)'); this.mediaHandler=e=>{this.reduced=e.matches;if(this.reduced){this.stopCamera();if(this.transition)this.transition.duration=0;this.request();}};
  this.media.addEventListener('change',this.mediaHandler);
  canvas.style.cssText+=';position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;';
  canvas.tabIndex=0; canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label','Схема денежных переводов. Перемещение стрелками, приближение плюс и минус, сброс клавишей 0. Клиенты доступны также в таблице переводов.');
  this.refreshTheme(); this.bind();
  this.observer=new ResizeObserver(()=>this.resize()); this.observer.observe(canvas.parentElement); this.resize();
 }
 listen(target,type,handler,options){target.addEventListener(type,handler,options);this.listeners.push(()=>target.removeEventListener(type,handler,options));}
 setData(data){
  if(!data||!Array.isArray(data.nodes)||!Array.isArray(data.edges)||data.nodes.some(n=>typeof n.gid!=='string'||!Number.isFinite(n.x)||!Number.isFinite(n.y)))throw new Error('Некорректные идентификаторы или координаты сети');
  this.data=data;this.nodes=new Map(data.nodes.map(n=>[n.gid,n]));this.adj=new Map(data.nodes.map(n=>[n.gid,[]]));
  this.edges=data.edges.filter(e=>typeof e.src==='string'&&typeof e.dst==='string'&&this.nodes.has(e.src)&&this.nodes.has(e.dst));
  this.edges.forEach((e,i)=>{this.adj.get(e.src).push(e);if(e.src!==e.dst)this.adj.get(e.dst).push(e)});
  this.edgeIds=new Map(this.edges.map((e,i)=>[e,i])); this.edgePairs=new Set(this.edges.map(e=>e.src+'>'+e.dst));
  this.sortedEdges=this.edges.slice().sort((a,b)=>(Number(b.sum_kzt)||0)-(Number(a.sum_kzt)||0));
  this.maxAmount=Math.max(1,...this.edges.map(e=>Number(e.sum_kzt)||0));this.sceneKey=null;this.rebuild(false);
 }
 setView(next={}){
  const old=this.view,view={...old,...next};this.previousView={...old};
  if(old.mode!=='focus'&&view.mode==='focus')this.overviewMemory={camera:{...this.camera},map:this.mapTransform?{...this.mapTransform}:null,mode:old.mode,clusterId:old.clusterId};
  if(!['flow','spatial'].includes(view.focusLayout))view.focusLayout='flow';
  if(view.gid!=null&&typeof view.gid!=='string')throw new Error('gid должен быть строкой');
  if(view.gid&&!this.nodes.has(view.gid))view.gid=null;
  if(!['focus','all','cluster'].includes(view.mode))view.mode='focus';
  if(!['all','in','out'].includes(view.direction))view.direction='all';
  this.view=view;this.removed=new Set(next.removedIds||view.removedIds||[]);
  const key=JSON.stringify([view.gid,view.mode,view.focusLayout,view.clusterId,view.direction,[...this.removed].sort()]);
  if(key===this.sceneKey){this.request();return;}
  this.sceneKey=key;
  if(old.mode!=='focus'&&view.mode===old.mode&&String(view.clusterId)===String(old.clusterId)&&view.direction==='all'&&old.direction==='all'&&this.positions.size&&JSON.stringify([...(old.removedIds||[])].sort())===JSON.stringify([...this.removed].sort())){this.previousView={...view};this.hover=null;this.hoverEdge=null;this.request();return;}
  this.rebuild(true);
 }
 refreshTheme(){
  const s=getComputedStyle(document.body),v=(key,fallback)=>s.getPropertyValue('--'+key).trim()||fallback;
  this.colors={panel:v('panel','#fff'),canvas:v('canvas','#fbfcfc'),text:v('ink','#1c2b31'),muted:v('muted','#748187'),soft:v('soft-text','#53666b'),line:v('line','#e7eceb'),green:v('green','#147a5b'),greenSoft:v('green-soft','#eaf5ee'),blue:v('blue','#5686bf'),blueSoft:v('blue-soft','#edf4fc'),amber:v('amber','#a67427'),violet:v('violet','#8162b3'),edgeIn:v('edge-in','#aebed4'),edgeOut:v('edge-out','#b3cec0')};
  this.font=v('font','-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif');this.mono=v('mono','Consolas, monospace');
  this.dark=document.documentElement.dataset.theme==='dark'||document.body.dataset.theme==='dark'||document.body.classList.contains('dark'); this.request();
 }
 resize(){
  if(this.destroyed)return;const rect=this.canvas.parentElement.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  if(!rect.width||!rect.height)return;if(rect.width===this.width&&rect.height===this.height&&d===this.dpr)return;
  const oldW=this.width,oldH=this.height;this.width=rect.width;this.height=rect.height;this.dpr=d;
  if(this.overviewMemory){this.overviewMemory.camera.x+=(this.width-oldW)/2;this.overviewMemory.camera.y+=(this.height-oldH)/2;}
  this.canvas.width=Math.round(rect.width*d);this.canvas.height=Math.round(rect.height*d);this.ctx.setTransform(d,0,0,d,0,0);
  if(this.userCamera||this.view.mode!=='focus'||this.view.focusLayout==='spatial'){this.camera.x+=(this.width-oldW)/2;this.camera.y+=(this.height-oldH)/2;this.request();}else this.rebuild(false);
 }
 focusTargets(){
  const gid=this.view.gid,targets=new Map();this.directIn=new Set();this.directOut=new Set();
  if(!gid||!this.nodes.has(gid))return{targets,edges:[],total:0};
  const all=(this.adj.get(gid)||[]).filter(e=>!this.removed.has(e.src)&&!this.removed.has(e.dst));
  const relevant=all.filter(e=>this.view.direction==='all'||(this.view.direction==='in'?e.dst===gid:e.src===gid));
  const relevantIds=new Set(relevant.flatMap(e=>[e.src,e.dst])),weights=new Map();
  for(const e of all){const other=e.src===gid?e.dst:e.src;if(other===gid)continue;weights.set(other,(weights.get(other)||0)+(Number(e.sum_kzt)||0));if(e.dst===gid)this.directIn.add(other);if(e.src===gid)this.directOut.add(other);}
  if(this.view.focusLayout==='spatial'){
   if(!this.mapTransform)this.makeMapTransform([...this.nodes.values()]);
   for(const id of [gid,...weights.keys()])if(id===gid||relevantIds.has(id)){const n=this.nodes.get(id);targets.set(id,{...this.mapPoint(n),core:0});}
   return{targets,edges:relevant,total:new Set(relevant.flatMap(e=>[e.src,e.dst]).filter(id=>id!==gid)).size,allEdges:relevant.length};
  }
  const order=(a,b)=>(weights.get(b)||0)-(weights.get(a)||0)||a.localeCompare(b);
  const incoming=[...this.directIn].sort(order),outgoing=[...this.directOut].filter(id=>!this.directIn.has(id)).sort(order);
  const w=this.width,h=this.height,mobile=w<520,rows=Math.max(2,Math.min(mobile?4:8,Math.floor((h-95)/(mobile?62:48)))),columns=w>=1000?2:1;
  const ins=incoming.slice(0,rows*columns),outs=outgoing.slice(0,rows*columns),compact=h<300;
  targets.set(gid,{x:w*(mobile?.48:.43),y:Math.max(58,Math.min(h-(compact?94:117),h*(compact?.38:.43))),core:1});
  const place=(ids,side)=>{const perColumn=Math.min(rows,Math.max(1,ids.length));ids.forEach((id,i)=>{const col=Math.floor(i/perColumn),count=Math.min(perColumn,ids.length-col*perColumn),row=i%perColumn,start=mobile?48:43,available=Math.max(0,h-(mobile?122:98)),step=count>1?Math.min(mobile?70:59,available/(count-1)):0,groupHeight=step*(count-1),y=start+Math.max(0,(available-groupHeight)/2)+row*step,x=side<0?w*(mobile?.11:.085)+col*(w*.14):w*(mobile?.84:.72)+col*(w*.15);targets.set(id,{x,y,core:0});});};place(ins,-1);place(outs,1);
  for(const id of targets.keys())if(id!==gid&&!relevantIds.has(id))targets.delete(id);
  const ids=new Set(targets.keys()),edges=relevant.filter(e=>ids.has(e.src)&&ids.has(e.dst));
  return{targets,edges,total:new Set(relevant.flatMap(e=>[e.src,e.dst]).filter(id=>id!==gid)).size,allEdges:relevant.length};
 }
 makeMapTransform(list){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const n of list){x0=Math.min(x0,n.x);x1=Math.max(x1,n.x);y0=Math.min(y0,n.y);y1=Math.max(y1,n.y);}
  if(!list.length){x0=y0=0;x1=y1=1;}const scale=Math.min(Math.max(40,this.width-90)/Math.max(.05,x1-x0),Math.max(60,this.height-105)/Math.max(.05,y1-y0));
  this.mapTransform={scale,x:this.width/2-(x0+x1)/2*scale,y:this.height/2-8+(y0+y1)/2*scale};
 }
 mapPoint(n){const m=this.mapTransform;return{x:m.x+n.x*m.scale,y:m.y-n.y*m.scale};}
 overviewTargets(){
  const cluster=this.view.mode==='cluster'&&this.view.clusterId!=null?String(this.view.clusterId):null;
  const list=[...this.nodes.values()].filter(n=>(cluster===null||String(n.cluster_id)===cluster)&&!this.removed.has(n.gid));
  const old=this.previousView||{};
  if(!this.forceFit&&old.mode==='focus'&&this.overviewMemory?.map&&this.overviewMemory.mode===this.view.mode&&String(this.overviewMemory.clusterId)===String(this.view.clusterId))this.mapTransform={...this.overviewMemory.map};
  else if(this.forceFit||!this.mapTransform||(old.mode!==this.view.mode||String(old.clusterId)!==String(this.view.clusterId))&&old.mode!=='focus')this.makeMapTransform(list);
  const targets=new Map(list.map(n=>[n.gid,{...this.mapPoint(n),core:0}])),selected=this.view.gid;
  const edges=this.sortedEdges.filter(e=>targets.has(e.src)&&targets.has(e.dst)&&(this.view.direction==='all'||!selected||(this.view.direction==='in'?e.dst===selected:e.src===selected)));
  return{targets,edges,total:list.length,allEdges:edges.length};
 }
 fitSpatial(targets){
  if(!targets.size)return{...this.camera};let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const p of targets.values()){x0=Math.min(x0,p.x);x1=Math.max(x1,p.x);y0=Math.min(y0,p.y);y1=Math.max(y1,p.y);}
  const scale=Math.max(.4,Math.min(8,(this.width-100)/Math.max(36,x1-x0),(this.height-115)/Math.max(36,y1-y0)));
  return{scale,x:this.width/2-(x0+x1)/2*scale,y:this.height/2-8-(y0+y1)/2*scale};
 }
 notifyStats(immediate=false){
  const key=JSON.stringify(this.stats);if(key===this.statsKey)return;
  if(immediate||!this.lastStatsAt||performance.now()-this.lastStatsAt>=100){clearTimeout(this.statsTimer);this.statsTimer=null;this.statsKey=key;this.lastStatsAt=performance.now();this.options.onStats?.({...this.stats});}
  else if(!this.statsTimer)this.statsTimer=setTimeout(()=>{this.statsTimer=null;this.notifyStats(true)},100-(performance.now()-this.lastStatsAt));
 }
 rebuild(animate=true){
  if(this.destroyed||!this.data){this.request();return;}const now=performance.now();this.advance(now);this.stopCamera();
  const snapshot=new Map();for(const[id,p]of this.positions)snapshot.set(id,{...this.project(p),alpha:p.alpha,core:p.core,dot:p.dot??(this.view.mode==='focus'?11:2.3),size:(p.size||1)*this.glyphScale(this.previousView||this.view)});
  const oldEdges=this.renderEdges,scene=this.view.mode==='focus'?this.focusTargets():this.overviewTargets();
  const old=this.previousView||this.view,spatial=this.view.mode==='focus'&&this.view.focusLayout==='spatial',sameMap=this.view.mode!=='focus'&&old.mode===this.view.mode&&String(old.clusterId)===String(this.view.clusterId),sameSpatial=spatial&&old.mode==='focus'&&old.focusLayout==='spatial';
  const anchor=snapshot.get(this.view.gid)||{x:this.width*.43,y:this.height*.43};
  let camera=sameMap||sameSpatial||this.view.mode==='focus'&&old.mode==='focus'&&old.focusLayout===this.view.focusLayout?{...this.camera}:{x:0,y:0,scale:1};
  if(spatial&&!sameSpatial)camera=this.fitSpatial(scene.targets);
  if(sameSpatial&&old.gid!==this.view.gid){const p=scene.targets.get(this.view.gid);if(p){const q=this.project(p);if(q.x<25||q.x>this.width-25||q.y<30||q.y>this.height-45)camera=this.fitSpatial(scene.targets);}}
  if(!this.forceFit&&this.view.mode!=='focus'&&old.mode==='focus'&&this.overviewMemory&&this.overviewMemory.mode===this.view.mode&&String(this.overviewMemory.clusterId)===String(this.view.clusterId))camera={...this.overviewMemory.camera};
  if(this.forceFit)camera=spatial?this.fitSpatial(scene.targets):{x:0,y:0,scale:1};this.forceFit=false;this.camera=camera;this.userCamera=sameMap||sameSpatial;
  const unproject=p=>({...p,x:(p.x-camera.x)/camera.scale,y:(p.y-camera.y)/camera.scale,size:(p.size||1)/this.glyphScale()});
  const next=new Map(),transitions=new Map(),nextEdges=new Map(),edgeTransitions=new Map();
  for(const[id,target]of scene.targets){const previous=snapshot.get(id),dot=this.view.mode==='focus'?(spatial?4.5:11):2.3,from=previous?unproject(previous):(spatial||this.view.mode!=='focus'?{...target,alpha:0,core:target.core,size:1,dot}:{...unproject(anchor),alpha:0,core:target.core,size:1,dot});next.set(id,{...from,n:this.nodes.get(id)});transitions.set(id,{from,to:{...target,alpha:1,size:1,dot}});}
  for(const[id,p]of snapshot)if(!scene.targets.has(id)&&p.alpha>.005){next.set(id,{...unproject(p),n:this.nodes.get(id)});transitions.set(id,{from:unproject(p),to:{...unproject(p),alpha:0}});}
  for(const e of scene.edges){const alpha=oldEdges.get(e)?.alpha||0;nextEdges.set(e,{alpha});edgeTransitions.set(e,{from:alpha,to:1});}
  const desired=new Set(scene.edges);for(const[e,p]of oldEdges)if(!desired.has(e)&&p.alpha>.005){nextEdges.set(e,{alpha:p.alpha});edgeTransitions.set(e,{from:p.alpha,to:0});}
  this.positions=next;this.renderEdges=nextEdges;this.visibleIds=new Set(scene.targets.keys());this.sceneEdges=scene.edges;
  this.stats={visibleNodes:scene.targets.size,visibleEdges:scene.edges.length,totalNeighbors:scene.total,hiddenNeighbors:this.view.mode==='focus'?Math.max(0,scene.total-scene.targets.size+1):0,totalEdges:scene.allEdges??scene.edges.length,totalNodes:scene.targets.size,drawnNodes:0,drawnEdges:0};
  this.notifyStats();
  this.transition={start:now,duration:animate&&!this.reduced&&snapshot.size?580:0,nodes:transitions,edges:edgeTransitions};this.hover=null;this.hoverEdge=null;this.advance(now);this.previousView={...this.view};this.reportZoom();this.request();
 }
 advance(now){
  if(!this.transition)return;const t=this.transition,d=t.duration?Math.max(0,Math.min(1,(now-t.start)/t.duration)):1,k=d*d*(3-2*d);
  for(const[id,v]of t.nodes){const p=this.positions.get(id);for(const field of ['x','y','alpha','core','size','dot'])p[field]=v.from[field]+(v.to[field]-v.from[field])*k;}
  for(const[e,v]of t.edges)this.renderEdges.get(e).alpha=v.from+(v.to-v.from)*k;
  if(d===1){for(const[id,p]of this.positions)if(p.alpha<.001)this.positions.delete(id);for(const[e,p]of this.renderEdges)if(p.alpha<.001)this.renderEdges.delete(e);this.transition=null;}
 }
 project(p){return{x:p.x*this.camera.scale+this.camera.x,y:p.y*this.camera.scale+this.camera.y};}
 glyphScale(view=this.view){return Math.min(view.mode==='focus'&&view.focusLayout!=='spatial'?2.4:1.6,Math.max(.7,Math.sqrt(this.camera.scale)));}
 radius(p){const local=this.view.mode==='focus';return (p.size||1)*this.glyphScale()*((p.dot??(local?11:2.3))+p.core*(this.height<300?19:this.width<520?18:23));}
 request(){if(this.destroyed||this.frame)return;this.frame=requestAnimationFrame(now=>{this.frame=0;this.paint(now)});}
 roundRect(x,y,w,h,r){const c=this.ctx;c.beginPath();if(c.roundRect)c.roundRect(x,y,w,h,r);else c.rect(x,y,w,h);}
 money(v){return new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(Number(v)||0)+' ₸';}
 signals(n){return[n.flag_fast_transit?'Быстрый транзит':null,n.flag_sync_collection?'Синхронные поступления':null,n.flag_structuring?'Дробление поступлений':null].filter(Boolean);}
 edgeColor(e,strong=false){const c=this.colors;return e.dst===this.view.gid?(strong?c.blue:c.edgeIn):e.src===this.view.gid?(strong?c.green:c.edgeOut):c.edgeOut;}
 edgePath(e){
  const pa=this.positions.get(e.src),pb=this.positions.get(e.dst);if(!pa||!pb)return null;const a=this.project(pa),b=this.project(pb),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  if(e.src===e.dst){const r=this.radius(pa);return{a:{x:a.x-r*.6,y:a.y-r*.8},b:{x:a.x+r*.6,y:a.y-r*.8},c1:{x:a.x-r*2.5,y:a.y-r*3.5},c2:{x:a.x+r*2.5,y:a.y-r*3.5},len:r*5};}
  if(len<4)return null;const ux=dx/len,uy=dy/len,r1=this.radius(pa)+2,r2=this.radius(pb)+5;
  const start={x:a.x+ux*r1,y:a.y+uy*r1},end={x:b.x-ux*r2,y:b.y-uy*r2};
  const reciprocal=this.edgePairs.has(e.dst+'>'+e.src),bend=reciprocal?Math.min(40,len*.15):0;
  return{a:start,b:end,c1:{x:start.x+(end.x-start.x)*.46-uy*bend,y:start.y+ux*bend},c2:{x:end.x-(end.x-start.x)*.34-uy*bend,y:end.y+ux*bend},len};
 }
 at(path,t){const u=1-t;return{x:u*u*u*path.a.x+3*u*u*t*path.c1.x+3*u*t*t*path.c2.x+t*t*t*path.b.x,y:u*u*u*path.a.y+3*u*u*t*path.c1.y+3*u*t*t*path.c2.y+t*t*t*path.b.y};}
 chooseDrawn(){
  const flow=this.view.mode==='focus'&&this.view.focusLayout!=='spatial',selected=this.view.gid,emphasis=new Set([selected,this.hover]);
  for(const e of this.adj.get(this.hover||selected)||[]){emphasis.add(e.src);emphasis.add(e.dst);}
  const candidates=[...this.positions.entries()].filter(([id,p])=>{if(!this.visibleIds.has(id)||p.alpha<.001)return false;const q=this.project(p);return q.x>-40&&q.x<this.width+40&&q.y>22&&q.y<this.height-35;});
  candidates.sort(([a,pa],[b,pb])=>Number(b===selected||b===this.hover)-Number(a===selected||a===this.hover)||Number(emphasis.has(b))-Number(emphasis.has(a))||(Number(pb.n.priority_score)||0)-(Number(pa.n.priority_score)||0)||a.localeCompare(b));
  const grid=new Set(),drawn=new Set(),cell=this.width<520?20:17;
  for(const[id,p]of candidates){const q=this.project(p),key=Math.floor(q.x/cell)+':'+Math.floor(q.y/cell);if(flow||!grid.has(key)||id===selected||id===this.hover){drawn.add(id);grid.add(key);}}
  this.drawnIds=drawn;this.lodAlpha=this.lodAlpha||new Map();let active=false;
  for(const id of drawn)if(!this.lodAlpha.has(id))this.lodAlpha.set(id,this.reduced?1:0);
  for(const[id,alpha]of this.lodAlpha){const target=drawn.has(id)?1:0,next=this.reduced?target:alpha+(target-alpha)*.24;if(Math.abs(next-target)>.015)active=true;this.lodAlpha.set(id,Math.abs(next-target)<.015?target:next);if(next<.005&&!target)this.lodAlpha.delete(id);}
  this.stats.drawnNodes=drawn.size;this.stats.totalNodes=this.visibleIds.size;
  if(active)this.request();
 }
 paintMapLabel(p,q){
  const c=this.ctx,col=this.colors,id=p.n.gid,selected=id===this.view.gid,hover=id===this.hover;
  if(!selected&&!hover&&(this.camera.scale<2.5||Number(p.n.priority_score)<.45||this.mapLabelCount>=9))return;
  const text=selected||hover?id:'…'+id.slice(-9);c.font=(selected?'600':'500')+' 11px '+this.mono;const width=c.measureText(text).width+12,r=this.radius(p),candidates=[{x:q.x+r+7,y:q.y-10},{x:q.x-r-width-7,y:q.y-10},{x:q.x-width/2,y:q.y-r-27},{x:q.x-width/2,y:q.y+r+8}].map(b=>({...b,w:width,h:21}));
  const fits=b=>b.x>=4&&b.x+b.w<=this.width-5&&b.y>=23&&b.y+b.h<=this.height-40;
  let box=candidates.find(b=>fits(b)&&!this.labelBoxes.some(a=>this.overlap(a,b)));
  if(!box&&(selected||hover))box=candidates.find(fits)||{x:Math.max(4,Math.min(this.width-width-5,q.x-width/2)),y:Math.max(23,Math.min(this.height-61,q.y+r+8)),w:width,h:21};
  if(!box)return;
  this.labelBoxes.push(box);this.mapLabelCount++;c.fillStyle=col.panel;this.roundRect(box.x,box.y,width,21,4);c.fill();c.fillStyle=selected?col.green:col.soft;c.fillText(text,box.x+6,box.y+14);
 }
 paint(now){
  if(this.destroyed)return;this.advance(now);const c=this.ctx,w=this.width,h=this.height,col=this.colors;c.clearRect(0,0,w,h);this.paths=[];this.labelBoxes=[];
  if(!this.data||!this.visibleIds?.size){c.font='500 13px '+this.font;c.fillStyle=col.muted;c.textAlign='center';c.fillText(this.data?'Выберите клиента, чтобы проследить переводы':'Загружаем схему сети…',w/2,h/2,Math.max(30,w-32));c.textAlign='left';return;}
  const local=this.view.mode==='focus',flow=local&&this.view.focusLayout!=='spatial',selected=this.view.gid;this.chooseDrawn();this.mapLabelCount=0;let drawnEdges=0,backgroundEdges=0;
  for(const[e,state]of this.renderEdges){
   if(state.alpha<.01||this.removed.has(e.src)||this.removed.has(e.dst)||!this.drawnIds.has(e.src)||!this.drawnIds.has(e.dst))continue;const path=this.edgePath(e);if(!path)continue;
   const hover=this.hoverEdge===e||(this.hover&&(e.src===this.hover||e.dst===this.hover));
   const focused=e.src===selected||e.dst===selected;if(!flow){if(path.len<15)continue;if(!local&&!focused&&!hover&&(path.len<35||backgroundEdges++>(this.camera.scale<1.7?22:Math.min(180,35+this.camera.scale*14))))continue;}drawnEdges++;const alpha=state.alpha*(local?.88:focused||hover?.85:.18)*(this.hover&&!hover?.22:1),importance=Math.log1p(Number(e.sum_kzt)||0)/Math.log1p(this.maxAmount);
   c.globalAlpha=alpha;c.strokeStyle=this.edgeColor(e,hover);c.lineWidth=local?1.35+importance*1.45:focused?1.5:.6+importance*.6;
   c.beginPath();c.moveTo(path.a.x,path.a.y);c.bezierCurveTo(path.c1.x,path.c1.y,path.c2.x,path.c2.y,path.b.x,path.b.y);c.stroke();
   if(local||focused||hover||this.camera.scale>2.7){const dx=path.b.x-path.c2.x,dy=path.b.y-path.c2.y,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,s=local?7:4;
    c.fillStyle=this.edgeColor(e,true);c.globalAlpha=Math.min(1,alpha*1.1);c.beginPath();c.moveTo(path.b.x,path.b.y);c.lineTo(path.b.x-ux*s-uy*s*.45,path.b.y-uy*s+ux*s*.45);c.lineTo(path.b.x-ux*s+uy*s*.45,path.b.y-uy*s-ux*s*.45);c.closePath();c.fill();}
   if(state.alpha>.5&&(local||focused||hover))this.paths.push({...path,e});
  }
  // Amounts are intentionally optional; labels avoid central badges and one another.
  if(this.view.amounts)for(const path of this.paths.slice(0,20)){const p=this.at(path,path.e.dst===selected?.46:.64),text=this.money(path.e.sum_kzt);c.font='500 10px '+this.font;const width=c.measureText(text).width+10,box={x:p.x-width/2,y:p.y-16,w:width,h:17};if(box.x<4||box.x+box.w>w-4||box.y<26||box.y+box.h>h-44||this.labelBoxes.some(b=>this.overlap(b,box)))continue;this.labelBoxes.push(box);c.globalAlpha=.92;c.fillStyle=col.canvas;this.roundRect(box.x,box.y,box.w,box.h,4);c.fill();c.globalAlpha=1;c.fillStyle=this.edgeColor(path.e,true);c.fillText(text,box.x+5,box.y+12);}
  this.stats.drawnEdges=drawnEdges;this.notifyStats();const points=[...this.positions.entries()].sort((a,b)=>Number(a[0]===selected)-Number(b[0]===selected)||a[1].core-b[1].core);
  for(const[id,p]of points){const lod=this.lodAlpha.get(id)||0;if(p.alpha<.01||lod<.01)continue;const q=this.project(p),r=this.radius(p);if(q.x< -160||q.x>w+160||q.y< -140||q.y>h+140)continue;
   const incoming=this.directIn?.has(id),reciprocal=incoming&&this.directOut?.has(id),isSelected=id===selected,signal=this.signals(p.n).length,color=incoming?col.blue:col.green;
   c.globalAlpha=p.alpha*lod*(this.hover&&this.hover!==id&&!this.isNeighbor(this.hover,id)?.4:1);
   if(p.core>.01){const alpha=c.globalAlpha;for(const[scale,opacity]of[[2.05,.045],[1.52,.06]]){c.globalAlpha=alpha*opacity*p.core;c.fillStyle=col.green;c.beginPath();c.arc(q.x,q.y,r*scale,0,Math.PI*2);c.fill();}c.globalAlpha=alpha;c.strokeStyle=col.green;c.lineWidth=1;c.globalAlpha*=.4*p.core;c.beginPath();c.arc(q.x,q.y,r+7,0,Math.PI*2);c.stroke();c.globalAlpha=alpha;}
   if(!local&&signal){c.fillStyle=p.n.is_seed?col.violet:col.amber;c.beginPath();c.arc(q.x,q.y,r,0,Math.PI*2);c.fill();}else{c.fillStyle=local?(incoming?col.blueSoft:col.greenSoft):(p.n.is_seed?col.green:col.soft);c.strokeStyle=local?color:col.panel;c.lineWidth=local?1.5:0;c.beginPath();c.arc(q.x,q.y,r,0,Math.PI*2);c.fill();if(local)c.stroke();if(p.core>.001){const alpha=c.globalAlpha;c.globalAlpha*=p.core;c.fillStyle=col.green;c.fill();c.globalAlpha=alpha;}}
   if(local&&p.core<.5){c.fillStyle=color;c.beginPath();c.arc(q.x,q.y,Math.max(2,r*.27),0,Math.PI*2);c.fill();}
   if((!local||!flow)&&isSelected){c.strokeStyle=col.green;c.lineWidth=2;c.beginPath();c.arc(q.x,q.y,r+5,0,Math.PI*2);c.stroke();}
   if(p.core>.05)this.paintCore(p,q,r);
   if(signal&&local){const sx=q.x+r*.85,sy=q.y-r*.85,s=3.6;c.fillStyle=col.panel;c.strokeStyle=col.amber;c.lineWidth=1.5;c.beginPath();c.arc(sx,sy,s,0,Math.PI*2);c.fill();c.stroke();}
   if(flow&&p.core<.7)this.paintNodeLabel(p,q,reciprocal,incoming);
  }
  if(!flow){const labelPoints=points.filter(([id,p])=>this.drawnIds.has(id)&&p.alpha>.4).sort(([a,pa],[b,pb])=>Number(b===selected)-Number(a===selected)||Number(b===this.hover)-Number(a===this.hover)||(Number(pb.n.priority_score)||0)-(Number(pa.n.priority_score)||0));for(const[id,p]of labelPoints){c.globalAlpha=p.alpha*(this.lodAlpha.get(id)||0);this.paintMapLabel(p,this.project(p));}}
  c.globalAlpha=1;c.textAlign='left';this.paintTooltip();if(this.transition)this.request();
 }
 paintCore(p,q,r){
  const c=this.ctx,col=this.colors,base=c.globalAlpha;c.globalAlpha*=p.core;c.strokeStyle=this.dark?'#193b2a':'#fff';c.lineWidth=1.5;c.lineCap='round';
  const k=r/34;c.save();c.translate(q.x,q.y);c.scale(k,k);c.beginPath();c.moveTo(-10,0);c.lineTo(0,0);c.moveTo(0,-11);c.lineTo(0,11);for(const y of[-11,0,11]){c.moveTo(0,y);c.lineTo(10,y);}c.stroke();for(const[x,y,rad]of[[-14,0,3.5],[14,-11,3],[14,0,3],[14,11,3]]){c.beginPath();c.arc(x,y,rad,0,Math.PI*2);c.stroke();}c.restore();
  const mobile=this.width<520,compact=this.height<300,fontSize=mobile?10.5:12,role=this.data.roles?.[p.n.role]?.label||p.n.role;
  c.font='500 '+fontSize+'px '+this.mono;const width=c.measureText(p.n.gid).width+20,y=q.y+r+(compact?12:17);
  this.roundRect(q.x-width/2,y,width,25,6);c.fillStyle=col.panel;c.fill();c.strokeStyle=col.line;c.lineWidth=1;c.stroke();c.textAlign='center';c.fillStyle=col.text;c.fillText(p.n.gid,q.x,y+17);
  c.font='500 '+(mobile?10:11)+'px '+this.font;c.fillStyle=col.soft;c.fillText(role+' · гипотеза',q.x,y+(compact?39:43),Math.min(this.width-20,240));
  if(compact){c.textAlign='left';c.globalAlpha=base;return;}
  const tx=(Number(p.n.in_tx)||0)+(Number(p.n.out_tx)||0),label=tx+' переводов';c.font='500 10px '+this.font;const lw=c.measureText(label).width+18;this.roundRect(q.x-lw/2,y+53,lw,21,5);c.fillStyle=col.greenSoft;c.fill();c.fillStyle=col.green;c.fillText(label,q.x,y+67);c.textAlign='left';c.globalAlpha=base;
 }
 paintNodeLabel(p,q,reciprocal,incoming){
  const c=this.ctx,mobile=this.width<520,r=this.radius(p),col=this.colors,alpha=c.globalAlpha;c.globalAlpha*=1-p.core;
  const text='…'+p.n.gid.slice(mobile?-6:-9),subtitle=reciprocal?'Встречные':incoming?'Плательщик':'Получатель';
  const x=mobile?q.x:q.x+r+8,y=mobile?q.y+r+15:q.y+3;c.textAlign=mobile?'center':'left';c.font='500 '+(mobile?10:11)+'px '+this.mono;c.fillStyle=col.soft;c.fillText(text,x,y);c.font='400 '+(mobile?9:10)+'px '+this.font;c.fillStyle=col.muted;c.fillText(subtitle,x,y+13);c.textAlign='left';c.globalAlpha=alpha;
 }
 overlap(a,b){return a.x<b.x+b.w+3&&a.x+a.w+3>b.x&&a.y<b.y+b.h+3&&a.y+a.h+3>b.y;}
 isNeighbor(a,b){if(a===b)return true;return(this.adj.get(a)||[]).some(e=>e.src===b||e.dst===b);}
 hit(x,y){let result=null,best=Infinity;for(const[id,p]of this.positions){if(p.alpha<.5||(this.lodAlpha?.get(id)||0)<.3||!this.visibleIds?.has(id)||!this.drawnIds?.has(id)||this.removed.has(id))continue;const q=this.project(p),d=Math.hypot(x-q.x,y-q.y);if(d<Math.max(this.view.mode==='focus'?17:8,this.radius(p)+6)&&d<best){result=id;best=d;}}return result;}
 hitEdge(x,y){let hit=null,best=7;for(const path of this.paths){let prev=path.a;for(let i=1;i<=18;i++){const p=this.at(path,i/18),dx=p.x-prev.x,dy=p.y-prev.y,l=dx*dx+dy*dy,k=l?Math.max(0,Math.min(1,((x-prev.x)*dx+(y-prev.y)*dy)/l)):0,d=Math.hypot(x-prev.x-k*dx,y-prev.y-k*dy);if(d<best){best=d;hit=path.e;}prev=p;}}return hit;}
 paintTooltip(){
  if(this.pointers.size||!this.hover&&!this.hoverEdge)return;const c=this.ctx,col=this.colors;let anchor,lines=[];
  if(this.hover){const n=this.nodes.get(this.hover),p=this.positions.get(this.hover);if(!n||!p)return;anchor=this.project(p);lines=[{text:n.gid,mono:true},{text:(this.data.roles?.[n.role]?.label||n.role)+' · гипотеза'},{text:'Вход '+this.money(n.in_kzt)+' · выход '+this.money(n.out_kzt)}];for(const text of this.signals(n))lines.push({text:'◇ '+text,signal:true});if(n.truncated_by_depth)lines.push({text:'Граница наблюдения: вывод ограничен',signal:true});}
  else{const e=this.hoverEdge;anchor=this.pointer||{x:this.width/2,y:this.height/2};lines=[{text:'Наблюдаемые переводы'},{text:'От  '+e.src,mono:true},{text:'→   '+e.dst,mono:true},{text:new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(e.sum_kzt)||0)+' ₸ · '+(Number(e.n_tx)||0)+' переводов'}];}
  c.font='500 11px '+this.font;const width=Math.min(this.width-16,Math.max(...lines.map(l=>{c.font='500 11px '+(l.mono?this.mono:this.font);return c.measureText(l.text).width}))+24),height=lines.length*20+18,x=Math.max(8,Math.min(this.width-width-8,anchor.x+18)),y=Math.max(8,Math.min(this.height-height-8,anchor.y-height-15));
  c.globalAlpha=1;c.shadowColor=this.dark?'#0003':'#16342718';c.shadowBlur=18;c.shadowOffsetY=4;this.roundRect(x,y,width,height,8);c.fillStyle=col.panel;c.fill();c.shadowBlur=0;c.shadowOffsetY=0;c.strokeStyle=col.line;c.lineWidth=1;c.stroke();c.textAlign='left';lines.forEach((l,i)=>{c.fillStyle=l.signal?col.amber:i===0?col.text:col.soft;c.font=(i===0?'600':'400')+' 11px '+(l.mono?this.mono:this.font);c.fillText(l.text,x+12,y+21+i*20,width-24)});
 }
 zoomLimits(){return this.view.mode==='focus'?{min:.4,max:8}:{min:.35,max:32};}
 reportZoom(){this.options.onZoom?.(this.camera.scale);}
 stopCamera(){cancelAnimationFrame(this.zoomFrame);cancelAnimationFrame(this.inertia);this.zoomFrame=0;this.inertia=0;this.zoomTarget=null;}
 zoomAt(factor,x=this.width/2,y=this.height/2){const before=this.camera.scale,scale=Math.max(this.zoomLimits().min,Math.min(this.zoomLimits().max,before*factor));this.camera.x=x-(x-this.camera.x)*scale/before;this.camera.y=y-(y-this.camera.y)*scale/before;this.camera.scale=scale;this.userCamera=true;this.reportZoom();this.request();}
 zoomBy(factor,x=this.width/2,y=this.height/2){if(!Number.isFinite(factor)||factor<=0)return;cancelAnimationFrame(this.inertia);this.inertia=0;this.hover=null;this.hoverEdge=null;this.zoomTarget=Math.max(this.zoomLimits().min,Math.min(this.zoomLimits().max,(this.zoomTarget||this.camera.scale)*factor));this.zoomAnchor={x,y};if(this.reduced){this.zoomAt(this.zoomTarget/this.camera.scale,x,y);this.zoomTarget=null;return;}if(this.zoomFrame)return;const tick=()=>{this.zoomFrame=0;if(!this.zoomTarget||this.destroyed)return;const target=this.zoomTarget,next=this.camera.scale+(target-this.camera.scale)*.24;this.zoomAt(next/this.camera.scale,this.zoomAnchor.x,this.zoomAnchor.y);if(Math.abs(target-next)>.002)this.zoomFrame=requestAnimationFrame(tick);else{this.zoomAt(target/this.camera.scale,this.zoomAnchor.x,this.zoomAnchor.y);this.zoomTarget=null;}};this.zoomFrame=requestAnimationFrame(tick);}
 fit(){this.forceFit=true;this.rebuild(true);}
 bind(){
  const canvas=this.canvas,pos=e=>{const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}};
  this.listen(canvas,'wheel',e=>{e.preventDefault();const p=pos(e),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?this.height:1);this.zoomBy(Math.exp(-Math.max(-160,Math.min(160,delta))*.002),p.x,p.y)},{passive:false});
  this.listen(canvas,'pointerdown',e=>{if(e.button!==0&&e.pointerType!=='touch')return;this.stopCamera();this.hover=null;this.hoverEdge=null;const p=pos(e);this.pointers.set(e.pointerId,p);this.drag={start:p,moved:this.pointers.size>1,last:performance.now(),vx:0,vy:0};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';this.request();});
  this.listen(canvas,'pointermove',e=>{const p=pos(e);this.pointer=p;if(!this.pointers.has(e.pointerId)){const hover=this.hit(p.x,p.y),edge=hover?null:this.hitEdge(p.x,p.y);if(hover!==this.hover||edge!==this.hoverEdge){this.hover=hover;this.hoverEdge=edge;canvas.style.cursor=hover?'pointer':edge?'help':'grab';this.options.onHover?.(hover);this.request();}return;}
   const old=this.pointers.get(e.pointerId),other=[...this.pointers.entries()].find(([id])=>id!==e.pointerId)?.[1],dx=p.x-old.x,dy=p.y-old.y,now=performance.now(),dt=Math.max(8,now-this.drag.last);
   if(other){const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(p.x-other.x,p.y-other.y);if(before)this.zoomAt(after/before,(old.x+other.x)/2,(old.y+other.y)/2);this.camera.x+=dx/2;this.camera.y+=dy/2;this.drag.moved=true;this.drag.vx=this.drag.vy=0;}
   else{this.camera.x+=dx;this.camera.y+=dy;this.drag.vx=.6*this.drag.vx+.4*dx/dt;this.drag.vy=.6*this.drag.vy+.4*dy/dt;if(Math.hypot(p.x-this.drag.start.x,p.y-this.drag.start.y)>4)this.drag.moved=true;}
   if(this.drag.moved)this.userCamera=true;this.drag.last=now;this.pointers.set(e.pointerId,p);this.request();});
  const end=(e,cancelled=false)=>{if(!this.pointers.has(e.pointerId))return;this.pointers.delete(e.pointerId);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(this.pointers.size){this.drag.moved=true;return;}canvas.style.cursor='grab';const drag=this.drag;this.drag=null;if(cancelled)return;if(!drag.moved){const p=pos(e),hit=this.hit(p.x,p.y);if(hit)this.options.onSelect?.(hit);else{this.hoverEdge=this.hitEdge(p.x,p.y);this.request();}return;}
   if(this.reduced||performance.now()-drag.last>90)return;let previous=performance.now(),vx=drag.vx,vy=drag.vy;const coast=now=>{this.inertia=0;if(this.destroyed)return;const dt=Math.min(32,now-previous);previous=now;this.camera.x+=vx*dt;this.camera.y+=vy*dt;const decay=Math.exp(-dt/145);vx*=decay;vy*=decay;this.request();if(Math.hypot(vx,vy)>.01)this.inertia=requestAnimationFrame(coast);};this.inertia=requestAnimationFrame(coast);};
  this.listen(canvas,'pointerup',e=>end(e));this.listen(canvas,'pointercancel',e=>end(e,true));
  this.listen(canvas,'pointerleave',()=>{if(!this.pointers.size){this.hover=null;this.hoverEdge=null;this.options.onHover?.(null);this.request();}});
  this.listen(canvas,'keydown',e=>{if(!['+','=','-','0','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(e.key))return;e.preventDefault();this.stopCamera();if(e.key==='+'||e.key==='=')this.zoomBy(1.3);else if(e.key==='-')this.zoomBy(1/1.3);else if(e.key==='0'||e.key==='Home')this.fit();else if(e.key==='Escape'){this.hover=null;this.hoverEdge=null;this.request();}else{this.camera.x+=e.key==='ArrowLeft'?45:e.key==='ArrowRight'?-45:0;this.camera.y+=e.key==='ArrowUp'?45:e.key==='ArrowDown'?-45:0;this.userCamera=true;this.request();}});
  this.listen(document,'visibilitychange',()=>{if(document.hidden)this.stopCamera();else this.request();});
 }
 destroy(){if(this.destroyed)return;this.destroyed=true;clearTimeout(this.statsTimer);this.stopCamera();cancelAnimationFrame(this.frame);this.observer.disconnect();this.media.removeEventListener('change',this.mediaHandler);for(const remove of this.listeners)remove();this.listeners=[];this.pointers.clear();this.positions.clear();this.renderEdges.clear();}
}
window.ApprovedGraph=ApprovedGraph;
