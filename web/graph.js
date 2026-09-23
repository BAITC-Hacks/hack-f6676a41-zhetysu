'use strict';
// Shared data contract and pointer controls. Rendering lives in MoneyGraph below.
class MoneyGraphBase {
 constructor(canvas,overlay,onSelect){
  this.canvas=canvas;this.overlay=overlay;this.ctx=canvas.getContext('2d');this.fx=overlay.getContext('2d');this.onSelect=onSelect;this.points=new Map();this.edges=[];this.nodes=[];this.visible=[];this.cluster='';this.selected=null;this.near=new Set();this.focusEdges=new Set();this.removed=new Set();this.falling=new Map();this.scale=1;this.ox=0;this.oy=0;this.W=1;this.H=1;this.motion=false;this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;this.hover=null;this.hoverNear=new Set();this.flowPaths=[];this.cacheColors();this.bind();new ResizeObserver(()=>this.resize()).observe(canvas.parentElement);
 }
 cacheColors(){const css=getComputedStyle(document.body);this.colors={};for(const k of ['text','muted','subtle','edge','accent','seed','canvas','coordinator','consolidator','distributor','transit','terminal','peripheral'])this.colors[k]=css.getPropertyValue('--'+k).trim()}
 setData(data){if(!data||!Array.isArray(data.nodes)||!Array.isArray(data.edges)||data.nodes.some(n=>typeof n.gid!=='string'||!Number.isFinite(n.x)||!Number.isFinite(n.y)))throw new Error('Некорректные идентификаторы или координаты сети');this.data=data;this.nodes=data.nodes;const validIds=new Set(this.nodes.map(n=>n.gid));this.edges=data.edges.filter(e=>validIds.has(e.src)&&validIds.has(e.dst));this.points=new Map();this.adj=new Map(this.nodes.map(n=>[n.gid,[]]));for(const e of this.edges){this.adj.get(e.src).push(e);if(e.src!==e.dst)this.adj.get(e.dst).push(e)}
  this.hasCoordinates=this.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y));
  for(const n of this.nodes)this.points.set(n.gid,{x:n.x*1000,y:(1-n.y)*1000,n});
  this.maxAmount=Math.max(1,...this.edges.map(e=>e.sum_kzt));this.edgeImportance=new Map(this.edges.map(e=>[e,Math.log1p(e.sum_kzt)/Math.log1p(this.maxAmount)]));this.sortedEdges=this.edges.slice().sort((a,b)=>b.sum_kzt-a.sum_kzt);
  this.seedParents=new Map();const queue=this.nodes.filter(n=>n.is_seed).map(n=>n.gid);for(const id of queue)this.seedParents.set(id,null);for(let i=0;i<queue.length;i++)for(const e of this.adj.get(queue[i]))if(e.src===queue[i]&&!this.seedParents.has(e.dst)){this.seedParents.set(e.dst,e);queue.push(e.dst)}
  this.areas=[];for(const c of data.clusters||[]){const ps=this.nodes.filter(n=>String(n.cluster_id)===String(c.cluster_id)).map(n=>this.points.get(n.gid));if(!ps.length)continue;const cx=Number.isFinite(c.x)?c.x:Number.isFinite(c.center_x)?c.center_x:c.center?.x,cy=Number.isFinite(c.y)?c.y:Number.isFinite(c.center_y)?c.center_y:c.center?.y;this.areas.push({id:String(c.cluster_id),size:ps.length,hull:this.hull(ps),x:this.hasCoordinates&&Number.isFinite(cx)?cx*1000:ps.reduce((a,p)=>a+p.x,0)/ps.length,y:this.hasCoordinates&&Number.isFinite(cy)?(1-cy)*1000:ps.reduce((a,p)=>a+p.y,0)/ps.length,r:this.hasCoordinates&&Number.isFinite(c.radius)?c.radius*1000:null})}
  this.areas.sort((a,b)=>b.size-a.size);this.selected=null;this.near.clear();this.focusEdges.clear();this.cluster='';this.local=false;this.removed.clear();this.filteredEdges=this.sortedEdges;this.visible=[...this.points.values()];this.resize();this.fit();this.startTime=this.motion?performance.now():0;this.request();
 }
 hull(points){if(points.length<3)return points;const ps=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y),cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),lower=[],upper=[];for(const p of ps){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p)}for(const p of ps.slice().reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p)}return lower.slice(0,-1).concat(upper.slice(0,-1))}
 select(id){if(!this.points.has(id))return;this.selected=id;this.near=new Set([id]);this.focusEdges=new Set(this.adj.get(id));for(const e of this.adj.get(id)){this.near.add(e.src);this.near.add(e.dst)}let cursor=id,guard=0;while(this.seedParents.get(cursor)&&guard++<this.nodes.length){const e=this.seedParents.get(cursor);this.focusEdges.add(e);this.near.add(e.src);this.near.add(e.dst);cursor=e.src}this.startTime=0;this.hover=null;this.filter('',true);this.request()}
 clear(){this.hover=null;this.selected=null;this.near.clear();this.focusEdges.clear();this.filter('')}
 setDay(day){this.day=day;this.request()}
 amount(e){if(!this.day||!Array.isArray(e.daily))return e.sum_kzt;return e.daily.reduce((s,d)=>s+(d.date<=this.day?Number(d.sum_kzt)||0:0),0)}
 zoom(f,x=this.W/2,y=this.H/2){this.userView=true;if(arguments.length===1&&!this.reduced){this.smoothZoom(f,x,y);return}const old=this.scale;this.scale=Math.max(Math.max(.025,(this.baseScale||.1)*.45),Math.min(Math.max(8,this.baseScale||1),this.scale*f));this.ox=x-(x-this.ox)*this.scale/old;this.oy=y-(y-this.oy)*this.scale/old;this.startTime=0;this.request()}
 request(){if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.paint()})}
 smoothZoom(f,x,y){this.zoomTarget=Math.max(Math.max(.025,(this.baseScale||.1)*.45),Math.min(Math.max(8,this.baseScale||1),(this.zoomTarget||this.scale)*f));this.zoomAnchor={x,y};if(this.reduced){this.zoom(this.zoomTarget/this.scale,x,y);this.zoomTarget=null;return}if(this.zoomFrame)return;const tick=()=>{this.zoomFrame=0;if(!this.zoomTarget)return;const target=this.zoomTarget,a=this.zoomAnchor,next=this.scale+(target-this.scale)*.3;this.zoom(next/this.scale,a.x,a.y);if(Math.abs(target-this.scale)>.001)this.zoomFrame=requestAnimationFrame(tick);else{this.zoom(target/this.scale,a.x,a.y);this.zoomTarget=null}};this.zoomFrame=requestAnimationFrame(tick)}
 money(v){return new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(Number(v)||0)+' ₸'}
 bind(){const c=this.canvas,pointers=new Map();let start=null,dragged=false,lastTime=0,vx=0,vy=0;const stop=()=>{cancelAnimationFrame(this.inertia);this.inertia=0;vx=vy=0};c.style.touchAction='none';c.style.cursor='grab';
  c.addEventListener('wheel',e=>{e.preventDefault();stop();const r=c.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?this.H:1),factor=Math.exp(-Math.max(-160,Math.min(160,delta))*.002);this.smoothZoom(factor,e.clientX-r.left,e.clientY-r.top)},{passive:false});
  c.onpointerdown=e=>{stop();this.zoomTarget=null;c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});start={x:e.clientX,y:e.clientY};dragged=pointers.size>1;lastTime=performance.now();this.hover=null;c.style.cursor='grabbing';this.request()};
  c.onpointermove=e=>{const r=c.getBoundingClientRect();if(!pointers.has(e.pointerId)){const hit=this.hit(e.clientX-r.left,e.clientY-r.top),id=hit?.n.gid||null;if(id!==this.hover){this.hover=id;this.hoverNear=new Set(id?[id]:[]);for(const edge of this.adj?.get(id)||[]){this.hoverNear.add(edge.src);this.hoverNear.add(edge.dst)}c.style.cursor=id?'pointer':'grab';this.request()}return}const old=pointers.get(e.pointerId),other=[...pointers.entries()].find(([id])=>id!==e.pointerId)?.[1],dx=e.clientX-old.x,dy=e.clientY-old.y,now=performance.now(),dt=Math.max(8,now-lastTime);if(other){const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y),mx=(old.x+other.x)/2-r.left,my=(old.y+other.y)/2-r.top;if(before)this.zoom(after/before,mx,my);this.ox+=dx/2;this.oy+=dy/2;dragged=true;vx=vy=0}else{this.ox+=dx;this.oy+=dy;vx=.6*vx+.4*dx/dt;vy=.6*vy+.4*dy/dt;if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>4){dragged=true;this.userView=true}}lastTime=now;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});this.request()};
  c.onpointerup=e=>{pointers.delete(e.pointerId);c.style.cursor='grab';if(pointers.size){dragged=true;return}if(!dragged){const r=c.getBoundingClientRect(),hit=this.hit(e.clientX-r.left,e.clientY-r.top);if(hit)this.onSelect(hit.n.gid);return}if(this.reduced||performance.now()-lastTime>90)return;let previous=performance.now();const coast=now=>{const dt=Math.min(32,now-previous);previous=now;this.ox+=vx*dt;this.oy+=vy*dt;const decay=Math.exp(-dt/170);vx*=decay;vy*=decay;this.request();if(Math.hypot(vx,vy)>.012)this.inertia=requestAnimationFrame(coast);else this.inertia=0};this.inertia=requestAnimationFrame(coast)};
  c.onpointercancel=e=>{pointers.delete(e.pointerId);dragged=true;stop();c.style.cursor='grab'};c.onpointerleave=()=>{this.hover=null;this.request()};document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();this.zoomTarget=null}else this.animate()});matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{this.reduced=e.matches;if(e.matches){stop();this.setMotion(false)}})
 }
}

// Local layouts use real directed edges. Overview coordinates remain intact.
// Snapshot screen positions before changing the camera so rapid selections
// continue from the visible frame, including when a transition is interrupted.
class MoneyGraph extends MoneyGraphBase {
 constructor(canvas,overlay,onSelect){
  super(canvas,overlay,onSelect);this.positions=new Map();this.renderEdges=new Map();this.edgePaths=[];this.hoverEdge=null;
  canvas.tabIndex=0;canvas.setAttribute('aria-keyshortcuts','+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown');
  canvas.addEventListener('keydown',e=>{
   if(!['+','=','-','0','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(e.key))return;e.preventDefault();this.stopCamera();this.hover=null;this.hoverEdge=null;
   if(e.key==='+'||e.key==='=')this.zoom(1.35);else if(e.key==='-')this.zoom(1/1.35);else if(e.key==='0'||e.key==='Home')this.fit();else{this.ox+=e.key==='ArrowLeft'?55:e.key==='ArrowRight'?-55:0;this.oy+=e.key==='ArrowUp'?55:e.key==='ArrowDown'?-55:0;this.userView=true;this.request()}
  });
 }
 cacheColors(){
  super.cacheColors();const dark=document.body.classList.contains('dark');Object.assign(this.colors,{incoming:dark?'#64bd93':'#247d55',outgoing:dark?'#82a8f2':'#3c6ecb',signal:dark?'#e1b55a':'#9b6917',path:dark?'#a0aca7':'#697970'});this.font='Manrope, system-ui, sans-serif';
 }
 setData(data){
  this.transition=null;this.positions=new Map();this.renderEdges=new Map();this.edgePaths=[];this.edgePairs=new Set((data.edges||[]).map(e=>e.src+'>'+e.dst));super.setData(data);this.changeScene(false);
 }
 resize(){
  const r=this.canvas.parentElement.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);if(!r.width||!r.height||this.W===r.width&&this.H===r.height&&this.dpr===d)return;
  const oldW=this.W,oldH=this.H;this.W=r.width;this.H=r.height;this.dpr=d;
  for(const c of [this.canvas,this.overlay]){c.width=Math.round(this.W*d);c.height=Math.round(this.H*d);c.getContext('2d').setTransform(d,0,0,d,0,0)}
  if(this.data&&!this.userView)this.changeScene(false);else{this.ox+=(this.W-oldW)/2;this.oy+=(this.H-oldH)/2;this.request()}
 }
 filter(cluster='',local=false){
  this.cluster=String(cluster);this.local=!!local;this.hover=null;this.hoverEdge=null;
  this.visible=[...this.points.values()].filter(p=>(!this.cluster||String(p.n.cluster_id)===this.cluster)&&(!local||this.near.has(p.n.gid)));
  const ids=new Set(this.visible.map(p=>p.n.gid));this.filteredEdges=this.sortedEdges.filter(e=>ids.has(e.src)&&ids.has(e.dst)&&(!local||this.focusEdges.has(e)));this.changeScene(true);
 }
 localLayout(){
  const targets=new Map([[this.selected,{x:0,y:0}]]),incoming=new Set(),outgoing=new Set(),weights=new Map();
  for(const e of this.adj.get(this.selected)||[]){if(e.src===e.dst)continue;const other=e.src===this.selected?e.dst:e.src;weights.set(other,(weights.get(other)||0)+(Number(e.sum_kzt)||0));if(e.dst===this.selected)incoming.add(other);else outgoing.add(other)}
  const order=(a,b)=>(weights.get(b)||0)-(weights.get(a)||0)||a.localeCompare(b),ins=[...incoming].sort(order),outs=[...outgoing].filter(id=>!incoming.has(id)).sort(order),maxRows=Math.max(3,Math.min(11,Math.floor(Math.max(0,this.H-160)/30)+1));
  // Reciprocal counterparties appear once; both arrows remain visible.
  const place=(ids,side)=>{const rows=Math.min(maxRows,Math.max(1,ids.length)),columns=Math.ceil(ids.length/rows);for(let i=0;i<ids.length;i++){const column=Math.floor(i/rows),length=Math.min(rows,ids.length-column*rows),row=i%rows;targets.set(ids[i],{x:side*(285+column*165),y:(row-(length-1)/2)*68})}return{x:side*(285+Math.max(0,columns-1)*82.5),y:-((rows-1)*68/2)-66,count:ids.length,columns,rows}};
  this.lanes={incoming:place(ins,-1),outgoing:place(outs,1)};
  const context=this.visible.filter(p=>!targets.has(p.n.gid)).sort((a,b)=>(a.n.depth||0)-(b.n.depth||0)||a.n.gid.localeCompare(b.n.gid)),bottom=Math.max(100,(Math.max(Math.min(maxRows,ins.length),Math.min(maxRows,outs.length))-1)*34+110);
  context.forEach((p,i)=>targets.set(p.n.gid,{x:(i-(context.length-1)/2)*145,y:bottom}));this.pathLane=context.length?{x:0,y:bottom+54}:null;
  // Use the available width independently of the depth of the incoming fan.
  if(this.W>=640){const ys=[...targets.values()].map(p=>p.y),span=Math.max(150,Math.max(...ys)-Math.min(...ys)),sy=Math.max(85,this.H-160)/span,extent=Math.max(285,...[...targets.values()].map(p=>Math.abs(p.x))),factor=Math.max(1,(this.W-240)*.4/(extent*sy));for(const[id,p]of targets)if(incoming.has(id)||outgoing.has(id))p.x*=factor;this.lanes.incoming.x*=factor;this.lanes.outgoing.x*=factor}return targets;
 }
 fitCamera(targets){
  if(!targets.size)return{scale:this.scale,ox:this.ox,oy:this.oy};let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of targets.values()){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y)}
  if(this.local&&targets.size>1){const span=Math.max(Math.abs(x0),Math.abs(x1));x0=-span;x1=span}
  const px=this.W<500?49:120,top=this.local?75:55,bottom=this.local?85:80,scale=Math.max(.025,Math.min(Math.max(75,this.W-px*2)/Math.max(240,x1-x0),Math.max(85,this.H-top-bottom)/Math.max(150,y1-y0),this.local?1.5:2.5));
  return{scale,ox:this.W/2-(x0+x1)/2*scale,oy:(this.H+top-bottom)/2-(y0+y1)/2*scale};
 }
 changeScene(animate=true){
  if(!this.data||!this.positions)return;const now=performance.now();this.advance(now);this.stopCamera();const snapshot=new Map();
  for(const[id,p]of this.positions)snapshot.set(id,{x:p.x*this.scale+this.ox,y:p.y*this.scale+this.oy,alpha:p.alpha,n:p.n});
  const oldEdges=new Map([...this.renderEdges].map(([e,state])=>[e,{alpha:state.alpha}])),targets=this.local&&this.selected?this.localLayout():new Map(this.visible.map(p=>[p.n.gid,{x:p.x,y:p.y}])),camera=this.fitCamera(targets);
  this.scale=camera.scale;this.baseScale=camera.scale;this.ox=camera.ox;this.oy=camera.oy;this.userView=false;
  const source=snapshot.get(this.selected)||{x:this.W/2,y:this.H/2},next=new Map(),transitions=new Map(),unproject=p=>({x:(p.x-this.ox)/this.scale,y:(p.y-this.oy)/this.scale});
  for(const[id,target]of targets){const n=this.points.get(id).n,previous=snapshot.get(id),from=unproject(previous||source),alpha=previous?.alpha||0;next.set(id,{...from,alpha,n});transitions.set(id,{from:{...from,alpha},to:{...target,alpha:1}})}
  for(const[id,p]of snapshot)if(!targets.has(id)&&p.alpha>.005){const from={...unproject(p),alpha:p.alpha};next.set(id,{...from,n:p.n});transitions.set(id,{from,to:{...from,alpha:0}})}
  const edgeTransitions=new Map(),nextEdges=new Map(),desired=new Set(this.filteredEdges);
  for(const e of this.filteredEdges){const alpha=oldEdges.get(e)?.alpha||0;nextEdges.set(e,{alpha});edgeTransitions.set(e,{from:alpha,to:1})}
  for(const[e,p]of oldEdges)if(!desired.has(e)&&p.alpha>.005){nextEdges.set(e,{alpha:p.alpha});edgeTransitions.set(e,{from:p.alpha,to:0})}
  this.positions=next;this.renderEdges=nextEdges;this.transition={start:now,duration:animate&&!this.reduced&&snapshot.size?580:0,nodes:transitions,edges:edgeTransitions};this.hover=null;this.hoverEdge=null;this.advance(this.transition.duration?now:now+1);this.fx.clearRect(0,0,this.W,this.H);this.request();
 }
 advance(now){
  if(!this.transition)return;const a=this.transition,t=a.duration&&!this.reduced?Math.min(1,Math.max(0,(now-a.start)/a.duration)):1,k=t*t*(3-2*t);
  for(const[id,v]of a.nodes){const p=this.positions.get(id);p.x=v.from.x+(v.to.x-v.from.x)*k;p.y=v.from.y+(v.to.y-v.from.y)*k;p.alpha=v.from.alpha+(v.to.alpha-v.from.alpha)*k}
  for(const[e,v]of a.edges)this.renderEdges.get(e).alpha=v.from+(v.to-v.from)*k;
  if(t===1){for(const[id,p]of this.positions)if(p.alpha<.001)this.positions.delete(id);for(const[e,p]of this.renderEdges)if(p.alpha<.001)this.renderEdges.delete(e);this.transition=null}
 }
 stopCamera(){cancelAnimationFrame(this.inertia);cancelAnimationFrame(this.zoomFrame);this.inertia=0;this.zoomFrame=0;this.zoomTarget=null}
 fit(){this.changeScene(true)}
 select(id){if(typeof id!=='string'||!this.points.has(id)||this.selected===id&&this.local)return;super.select(id)}
 screen(p){const live=p.n?this.positions?.get(p.n.gid)||p:p;return{x:live.x*this.scale+this.ox,y:live.y*this.scale+this.oy}}
 radius(n){const score=Math.max(0,Math.min(1,Number(n.priority_score)||0));if(this.local)return n.gid===this.selected?11:Math.max(5,Math.min(10,(5+score*3)*Math.sqrt(this.scale+.45)));return Math.max(1.7,Math.min(13,(2.2+score*7.2)*Math.sqrt(this.scale)))}
 signals(n){return[n.flag_fast_transit?'Быстрый транзит':null,n.flag_sync_collection?'Синхронные поступления':null,n.flag_structuring?'Дробление поступлений':null].filter(Boolean)}
 setMotion(enabled){this.motion=!!enabled&&!this.reduced;this.motionUntil=this.motion?performance.now()+1800:0;if(!this.motion)this.fx.clearRect(0,0,this.W,this.H);this.request()}
 setRemoved(ids){this.removed=new Set(ids);this.hover=null;this.hoverEdge=null;this.request()}
 animate(){if(this.motion&&performance.now()<this.motionUntil)this.request()}
 curve(e){
  const pa=this.points.get(e.src),pb=this.points.get(e.dst),a=this.screen(pa),b=this.screen(pb),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  if(e.src===e.dst){const r=this.radius(pa.n);return{a:{x:a.x-r*.7,y:a.y-r*.7},b:{x:a.x+r*.7,y:a.y-r*.7},c:{x:a.x,y:a.y-r-48},len:55}}
  if(len<2)return null;const ux=dx/len,uy=dy/len,startRadius=this.radius(pa.n)+3,endRadius=this.radius(pb.n)+6,start={x:a.x+ux*startRadius,y:a.y+uy*startRadius},end={x:b.x-ux*endRadius,y:b.y-uy*endRadius},reciprocal=this.edgePairs.has(e.dst+'>'+e.src),bend=Math.min(reciprocal?58:29,len*(reciprocal?.2:.08));return{a:start,b:end,c:{x:(start.x+end.x)/2-uy*bend,y:(start.y+end.y)/2+ux*bend},len};
 }
 edgeColor(e){return e.dst===this.selected?this.colors.incoming:e.src===this.selected?this.colors.outgoing:this.colors.path}
 paint(){
  const c=this.ctx,now=performance.now();this.advance(now);c.clearRect(0,0,this.W,this.H);if(!this.data)return;this.cacheColors();this.flowPaths=[];this.edgeLabels=[];this.edgePaths=[];const colors=this.colors,overview=!this.local&&this.scale<.7;
  if(!this.local&&!this.transition)for(const[i,a]of this.areas.entries()){
   if((this.cluster&&this.cluster!==a.id)||a.size<3||a.hull.length<3)continue;c.beginPath();a.hull.forEach((p,j)=>{const q=this.screen(p);j?c.lineTo(q.x,q.y):c.moveTo(q.x,q.y)});c.closePath();c.fillStyle=colors.edge;c.globalAlpha=.04;c.fill();c.strokeStyle=colors.edge;c.lineWidth=.8;c.globalAlpha=.18;c.stroke();
   if((i<8||this.cluster)&&!this.selected){const p=this.screen({x:a.x,y:Math.min(...a.hull.map(p=>p.y))});if(p.x>40&&p.x<this.W-60&&p.y>50&&p.y<this.H-70){c.globalAlpha=.85;c.font='600 11px '+this.font;c.fillStyle=colors.muted;c.fillText('КЛАСТЕР '+a.id,p.x-30,p.y-12)}}
  }
  let background=0;const edgeEntries=[...this.renderEdges].sort(([a],[b])=>Number(this.focusEdges.has(b))-Number(this.focusEdges.has(a)));
  for(const[e,state]of edgeEntries){
   if(state.alpha<.01||this.removed.has(e.src)||this.removed.has(e.dst)||!this.amount(e))continue;const focused=this.focusEdges.has(e),direct=e.src===this.selected||e.dst===this.selected,hovered=this.hoverEdge===e||!!this.hover&&(e.src===this.hover||e.dst===this.hover);
   if(!focused&&background++>(overview?this.W<600?220:550:Infinity))continue;const path=this.curve(e);if(!path)continue;const{a,b,c:cp,len}=path;if((a.x< -70&&b.x< -70)||(a.x>this.W+70&&b.x>this.W+70)||(a.y< -70&&b.y< -70)||(a.y>this.H+70&&b.y>this.H+70))continue;
   const importance=this.edgeImportance.get(e)||0,hue=focused?this.edgeColor(e):colors.edge,alpha=state.alpha*(hovered?1:focused?direct?.83:.57:this.selected?.1:overview?.22:.4)*(this.hover&&!hovered?.25:1);
   c.globalAlpha=alpha;c.strokeStyle=hue;c.lineWidth=focused?1.15+importance*1.7:.55+importance;c.setLineDash(focused&&!direct?[4,5]:[]);c.beginPath();c.moveTo(a.x,a.y);c.quadraticCurveTo(cp.x,cp.y,b.x,b.y);c.stroke();c.setLineDash([]);
   if(focused||!overview||importance>.83){const tx=b.x-cp.x,ty=b.y-cp.y,l=Math.hypot(tx,ty)||1,vx=tx/l,vy=ty/l,s=focused?8:5;c.globalAlpha=Math.min(1,alpha*1.2);c.fillStyle=hue;c.beginPath();c.moveTo(b.x,b.y);c.lineTo(b.x-vx*s-vy*s*.48,b.y-vy*s+vx*s*.48);c.lineTo(b.x-vx*s+vy*s*.48,b.y-vy*s-vx*s*.48);c.closePath();c.fill()}
   if(state.alpha>.4&&(this.local||!overview))this.edgePaths.push({...path,e});if(this.local&&direct&&state.alpha>.8&&len>125&&this.edgeLabels.length<7)this.edgeLabels.push({x:.25*a.x+.5*cp.x+.25*b.x,y:.25*a.y+.5*cp.y+.25*b.y,text:this.money(this.amount(e)),color:hue});
   if(this.motion&&focused&&this.flowPaths.length<35)this.flowPaths.push({...path,color:hue,phase:(this.flowPaths.length*.618)%1});
  }
  for(const[id,p]of this.positions){
   if(p.alpha<.01)continue;const n=p.n,q=this.screen(p),r=this.radius(n);if(q.x< -25||q.y< -25||q.x>this.W+25||q.y>this.H+25)continue;const selected=id===this.selected,removed=this.removed.has(id),signal=this.signals(n).length;let alpha=p.alpha*(removed?.16:!this.selected||this.near.has(id)?1:.18);if(this.hover&&!this.hoverNear.has(id))alpha*=.35;
   c.globalAlpha=alpha;c.fillStyle=selected?colors.accent:n.is_seed?colors.accent:colors.muted;c.beginPath();c.arc(q.x,q.y,r,0,Math.PI*2);c.fill();
   if(selected||n.is_seed){c.strokeStyle=selected?colors.accent:colors.seed||colors.accent;c.lineWidth=selected?2:1.3;c.beginPath();c.arc(q.x,q.y,r+4,0,Math.PI*2);c.stroke()}
   if(signal&&(this.local||this.scale>.65||selected)){const x=q.x+r+5,y=q.y-r-4,s=4.3;c.fillStyle=colors.canvas;c.strokeStyle=colors.signal;c.lineWidth=1.5;c.beginPath();c.moveTo(x,y-s);c.lineTo(x+s,y);c.lineTo(x,y+s);c.lineTo(x-s,y);c.closePath();c.fill();c.stroke()}
   if(removed){c.strokeStyle=colors.muted;c.lineWidth=1.5;c.beginPath();c.moveTo(q.x-r,q.y+r);c.lineTo(q.x+r,q.y-r);c.stroke()}
  }
  c.globalAlpha=1;this.paintLaneLabels();this.paintLabels();this.paintTooltip();this.fx.clearRect(0,0,this.W,this.H);if(this.motion&&!this.reduced&&now<this.motionUntil)this.paintFlow(now);if(this.transition||(this.motion&&now<this.motionUntil))this.request();
 }
 paintLaneLabels(){
  if(!this.local||!this.lanes)return;const c=this.ctx,alpha=this.transition?Math.min(1,Math.max(0,(performance.now()-this.transition.start-180)/350)):1;c.font='700 12px '+this.font;c.globalAlpha=alpha;
  for(const[key,title]of[['incoming','Входящие'],['outgoing','Исходящие']]){const lane=this.lanes[key];if(!lane.count)continue;const q=this.screen(lane);q.y=48;if(this.W<640){q.x=key==='incoming'?78:this.W-80}const text=(key==='incoming'?'→ ':'')+title+(key==='outgoing'?' →':''),width=c.measureText(text).width;if(q.y<40||q.y>this.H-70||q.x<width/2||q.x>this.W-width/2)continue;c.fillStyle=this.colors.canvas;c.fillRect(q.x-width/2-7,q.y-15,width+14,24);c.fillStyle=this.colors[key];c.fillText(text,q.x-width/2,q.y+2)}
  if(this.pathLane){const q=this.screen(this.pathLane),text='Наблюдаемый путь от исходных';c.font='500 11px '+this.font;c.fillStyle=this.colors.muted;if(q.y>50&&q.y<this.H-60)c.fillText(text,Math.max(16,q.x-c.measureText(text).width/2),q.y)}c.globalAlpha=1;
 }
 paintLabels(){
  if(!this.local)return;const c=this.ctx,boxes=[],gap=4,top=58,bottom=this.H-74,roles={coordinator:'Координатор',consolidator:'Консолидация',transit:'Транзит',distributor:'Распределитель',terminal:'Получатель',peripheral:'Периферия'};
  const nodes=this.visible.filter(p=>(this.positions.get(p.n.gid)?.alpha||0)>.7&&!this.removed.has(p.n.gid)).sort((a,b)=>(b.n.gid===this.selected)-(a.n.gid===this.selected)||(b.n.priority_score||0)-(a.n.priority_score||0)),obstacles=nodes.map(p=>{const q=this.screen(p),r=this.radius(p.n)+5;return{x:q.x-r,y:q.y-r,w:r*2,h:r*2}}),overlaps=(a,b)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;let count=0;
  for(const p of nodes){
   if(count>=24)break;const q=this.screen(p),selected=p.n.gid===this.selected;if(q.x<0||q.x>this.W||q.y<top||q.y>bottom)continue;const text=selected?p.n.gid:'…'+p.n.gid.slice(this.W<500||this.lanes.incoming.columns>1||this.lanes.outgoing.columns>1?-6:-9),role=roles[p.n.role]||p.n.role;c.font='600 12px ui-monospace, monospace';const w=Math.max(c.measureText(text).width,selected?c.measureText(role).width:0)+12,h=selected?38:22,r=this.radius(p.n)+(selected?12:9),left={x:q.x-r-w,y:q.y-h/2},right={x:q.x+r,y:q.y-h/2},below={x:q.x-w/2,y:q.y+r},above={x:q.x-w/2,y:q.y-r-h},point=this.positions.get(p.n.gid),candidates=(selected?[below,above,right,left]:point.x<0?[left,right,below,above]:[right,left,below,above]).map(a=>({...a,w,h}));
   let box=candidates.find(a=>a.x>=9&&a.x+w<this.W-9&&a.y>=top&&a.y+h<bottom&&!boxes.some(b=>overlaps(a,b))&&!obstacles.some(b=>overlaps(a,b)));if(!box&&selected)box={x:Math.max(9,Math.min(this.W-w-9,q.x-w/2)),y:Math.max(top,Math.min(bottom-h,q.y+r)),w,h};if(!box)continue;boxes.push(box);count++;c.globalAlpha=point.alpha;c.fillStyle=this.colors.canvas;c.fillRect(box.x-2,box.y-2,w+4,h+4);c.fillStyle=selected?this.colors.accent:this.colors.text;c.font=(selected?'700':'600')+' 12px ui-monospace, monospace';c.fillText(text,box.x+6,box.y+(selected?14:15));if(selected){c.font='500 11px '+this.font;c.fillStyle=this.colors.muted;c.fillText(role,box.x+6,box.y+31)}
  }
  c.globalAlpha=1;c.font='600 11px '+this.font;if(!this.transition)for(const e of this.edgeLabels){const w=c.measureText(e.text).width+14,box={x:e.x-w/2,y:e.y-11,w,h:22};if(box.x<9||box.x+w>this.W-9||box.y<top||box.y+22>bottom||boxes.some(b=>overlaps(box,b))||obstacles.some(b=>overlaps(box,b)))continue;boxes.push(box);c.fillStyle=this.colors.canvas;c.fillRect(box.x,box.y,box.w,box.h);c.fillStyle=e.color;c.fillText(e.text,box.x+7,box.y+15)}
 }

 paintFlow(now){const c=this.fx;c.globalAlpha=.8;for(const path of this.flowPaths){const t=(now*.00016+path.phase)%1,u=1-t,x=u*u*path.a.x+2*u*t*path.c.x+t*t*path.b.x,y=u*u*path.a.y+2*u*t*path.c.y+t*t*path.b.y;c.fillStyle=path.color;c.beginPath();c.arc(x,y,2,0,Math.PI*2);c.fill()}}
 hit(x,y){let hit=null,best=Infinity;for(const p of this.visible){if(this.removed.has(p.n.gid)||(this.positions.get(p.n.gid)?.alpha||0)<.45)continue;const q=this.screen(p),d=Math.hypot(x-q.x,y-q.y);if(d<Math.max(13,this.radius(p.n)+7)&&d<best){hit=p;best=d}}return hit}
 hitEdge(x,y){let best=7,hit=null;for(const path of this.edgePaths){let previous=path.a;for(let i=1;i<=20;i++){const t=i/20,u=1-t,q={x:u*u*path.a.x+2*u*t*path.c.x+t*t*path.b.x,y:u*u*path.a.y+2*u*t*path.c.y+t*t*path.b.y},dx=q.x-previous.x,dy=q.y-previous.y,l=dx*dx+dy*dy,k=l?Math.max(0,Math.min(1,((x-previous.x)*dx+(y-previous.y)*dy)/l)):0,d=Math.hypot(x-previous.x-k*dx,y-previous.y-k*dy);if(d<best){best=d;hit=path.e}previous=q}}return hit}
 paintTooltip(){
  if(!this.hover&&!this.hoverEdge)return;const c=this.ctx,lines=[];let anchor;
  if(this.hover){const p=this.points.get(this.hover);if(!p)return;const n=p.n;anchor=this.screen(p);lines.push({text:n.gid,mono:true},{text:this.data.roles?.[n.role]?.label||n.role},{text:'Вход '+this.money(n.in_kzt)+' · Выход '+this.money(n.out_kzt)});const signals=this.signals(n);if(signals.length){lines.push({text:'◇ Признаки клиента для проверки',signal:true});for(const text of signals)lines.push({text,signal:true})}}
  else{const e=this.hoverEdge;anchor=this.pointer||{x:this.W/2,y:this.H/2};lines.push({text:'Наблюдаемые переводы'},{text:'От  '+e.src,mono:true},{text:'→   '+e.dst,mono:true},{text:new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(this.amount(e))+' ₸ · '+(Number(e.n_tx)||0)+' переводов'})}
  c.font='600 12px '+this.font;const width=Math.min(this.W-16,Math.max(...lines.map(l=>c.measureText(l.text).width))+28),height=lines.length*21+19,x=Math.max(8,Math.min(this.W-width-8,anchor.x+18)),y=Math.max(8,Math.min(this.H-height-8,anchor.y-height-16));c.globalAlpha=1;c.shadowColor='rgba(0,0,0,.12)';c.shadowBlur=15;c.shadowOffsetY=4;c.fillStyle=this.colors.canvas;c.fillRect(x,y,width,height);c.shadowBlur=0;c.shadowOffsetY=0;c.strokeStyle=this.colors.subtle||this.colors.edge;c.lineWidth=1;c.strokeRect(x+.5,y+.5,width,height);lines.forEach((l,i)=>{c.fillStyle=l.signal?this.colors.signal:i===0?this.colors.text:this.colors.muted;c.font=(i===0?'700':'500')+' 12px '+(l.mono?'ui-monospace, monospace':this.font);c.fillText(l.text,x+13,y+22+i*21,width-26)});
 }
 bind(){
  super.bind();const c=this.canvas,move=c.onpointermove,down=c.onpointerdown,up=c.onpointerup,leave=c.onpointerleave;this.pointerActive=new Set();
  c.onpointerdown=e=>{this.pointerActive.add(e.pointerId);this.tapStart={x:e.clientX,y:e.clientY};this.tapMoved=false;this.hoverEdge=null;cancelAnimationFrame(this.zoomFrame);this.zoomFrame=0;down(e)};
  c.onpointermove=e=>{const r=c.getBoundingClientRect();this.pointer={x:e.clientX-r.left,y:e.clientY-r.top};if(this.pointerActive.size&&this.tapStart&&Math.hypot(e.clientX-this.tapStart.x,e.clientY-this.tapStart.y)>4)this.tapMoved=true;move(e);if(!this.pointerActive.size){const edge=this.hover?null:this.hitEdge(this.pointer.x,this.pointer.y);if(edge!==this.hoverEdge){this.hoverEdge=edge;if(edge)c.style.cursor='help';this.request()}}};
  c.onpointerup=e=>{this.pointerActive.delete(e.pointerId);up(e);if(!this.pointerActive.size&&!this.tapMoved){const r=c.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(!this.hit(x,y)){this.hoverEdge=this.hitEdge(x,y);this.pointer={x,y};this.request()}}};
  const cancel=c.onpointercancel;c.onpointercancel=e=>{this.pointerActive.delete(e.pointerId);this.tapMoved=true;cancel(e)};c.onpointerleave=()=>{this.hoverEdge=null;leave()};
  c.addEventListener('wheel',()=>{this.hoverEdge=null;this.hover=null},{passive:true});
 }
}
