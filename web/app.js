'use strict';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numberFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const fmt=n=>n!=null&&Number.isFinite(Number(n))?numberFormat.format(Number(n)):'—';
const money=n=>fmt(n)+' ₸';
const pct=n=>n==null?'Не рассчитано':(Number(n)*100).toLocaleString('ru-RU',{maximumFractionDigits:1})+'%';
let data=null,byId=new Map(),adj=new Map(),selected=null,simulation=null,removalCount=0,currentTab='network',fingerprint='',loading=false,simulationFrame=0;
let restoring=false;
let decisions={};try{const saved=JSON.parse(localStorage.getItem('money-review')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))decisions=saved}catch(_){}
try{document.body.classList.toggle('dark',localStorage.getItem('money-theme')==='dark')}catch(_){}
const graph=new MoneyGraph($('canvas'),$('flow-canvas'),selectNode);
function msg(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error)}
function role(key){return data?.roles?.[key]?.label||key||'Не определена'}
function color(key){return 'var(--'+({coordinator:1,consolidator:1,distributor:1,transit:1,terminal:1,peripheral:1}[key]?key:'peripheral')+')'}
function isRemoved(id){return !!simulation&&(simulation.removedRank.get(id)||Infinity)<=removalCount}
function savePosition(replace=false){
 if(restoring||!data)return;
 const u=new URL(location.href);u.searchParams.set('view',currentTab);
 if(selected)u.searchParams.set('gid',selected);else u.searchParams.delete('gid');
 if(removalCount)u.searchParams.set('remove',String(removalCount));else u.searchParams.delete('remove');
 if($('cluster').value)u.searchParams.set('cluster',$('cluster').value);else u.searchParams.delete('cluster');
 if(u.href!==location.href)history[replace?'replaceState':'pushState']({},'',u);
}
function tab(name,persist=true){
 if(!['network','top','clusters','terminal','ask'].includes(name))name='network';
 currentTab=name;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==name);
 document.querySelectorAll('[data-tab]').forEach(el=>{el.classList.toggle('active',el.dataset.tab===name);el.setAttribute('aria-current',el.dataset.tab===name?'page':'false')});
 document.body.classList.toggle('document-mode',name!=='network');
 if(name==='network')requestAnimationFrame(()=>{graph.resize();graph.request()});
 if(persist)savePosition();
}
function selectNode(id,persist=true){
 if(typeof id!=='string'||!byId.has(id)){msg('Клиент с gid '+id+' не найден. Проверьте полный номер.',true);return}
 selected=id;$('cluster').value='';tab('network',false);graph.select(id);$('gid').value=id;dossier(byId.get(id));updateGraphTitle();renderQueue();
 msg('Окружение клиента и наблюдаемый путь от исходных клиентов.');
 if(persist){savePosition();if(matchMedia('(max-width:760px)').matches)requestAnimationFrame(()=>$('dossier').scrollIntoView({block:'start'}));}
}
function renderQueue(){
 const index=data.top_nodes.findIndex(n=>n.gid===selected);
 $('queue-position').textContent=index<0?'Вне очереди':String(index+1).padStart(2,'0')+' / '+data.top_nodes.length;
 $('queue-prev').disabled=index<=0;$('queue-next').disabled=!data.top_nodes.length||index===data.top_nodes.length-1;
 $('queue-strip').innerHTML=data.top_nodes.map(n=>'<button class="queue-item '+(n.gid===selected?'active':'')+'" data-gid="'+esc(n.gid)+'" title="'+esc(n.gid)+' · '+esc(role(n.role))+'" aria-label="Приоритет '+esc(n.rank)+', клиент '+esc(n.gid)+'" aria-pressed="'+(n.gid===selected)+'"><span class="queue-number">'+String(n.rank).padStart(2,'0')+(decisions[n.gid]?' · '+(decisions[n.gid]==='check'?'✓':'−'):'')+'</span><strong>…'+esc(n.gid.slice(-9))+'</strong><small>'+esc(role(n.role))+'</small></button>').join('');
 const active=$('queue-strip').querySelector('.active');if(active){const strip=$('queue-strip');if(active.offsetLeft<strip.scrollLeft||active.offsetLeft+active.offsetWidth>strip.scrollLeft+strip.clientWidth)strip.scrollLeft=active.offsetLeft-strip.offsetLeft;}
}
function moveQueue(delta){if(!data)return;const i=data.top_nodes.findIndex(n=>n.gid===selected),next=data.top_nodes[Math.max(0,i+delta)];if(next)selectNode(next.gid)}
function restorePosition(){
 if(!data)return;restoring=true;const u=new URL(location.href),id=u.searchParams.get('gid'),cluster=u.searchParams.get('cluster');
 const n=Math.max(0,Math.min(50,Number(u.searchParams.get('remove'))||0));$('remove-count').value=n;updateSimulation();
 if(id&&byId.has(id))selectNode(id,false);
 else if(cluster&&[...$('cluster').options].some(o=>o.value===cluster)){overview();$('cluster').value=cluster;graph.clear();graph.filter(cluster);updateGraphTitle();}
 else if(u.searchParams.has('view')){overview();graph.clear();updateGraphTitle();}
 else if(data.top_nodes[0])selectNode(data.top_nodes[0].gid,false);
 else {overview();graph.clear();updateGraphTitle();}
 tab(u.searchParams.get('view')||'network',false);restoring=false;
 if(id&&!byId.has(id))msg('Сохранённый клиент отсутствует в текущей выгрузке. Выберите клиента из очереди.',true);
}
function updateGraphTitle(){
 $('graph-title').textContent=selected?'Денежное окружение':$('cluster').value?'Сообщество '+$('cluster').value:'Сеть переводов';
 $('visible-count').textContent=fmt(graph.visible.length)+' клиентов · '+fmt(graph.filteredEdges?.length||0)+' связей';
 $('map-note').textContent=selected?'Связи клиента и путь от исходных клиентов':'Обзор крупных переводов. Приблизьте для всех связей.';
}
function overview(){
 selected=null;$('review-actions').hidden=true;if(data)renderQueue();$('inspector-label').textContent='ОЧЕРЕДЬ ПРОВЕРКИ';$('inspector-close').hidden=true;
 $('dossier').innerHTML='<p class="queue-intro">Начните с этих клиентов.<br>Приоритет — рекомендация для проверки, не оценка виновности.</p>'+data.top_nodes.slice(0,6).map(n=>'<button class="priority-card" data-gid="'+esc(n.gid)+'"><div class="priority-top"><span class="priority-rank">'+String(n.rank).padStart(2,'0')+' / ПРИОРИТЕТ</span><span class="priority-score">'+pct(n.priority_score)+'</span></div><strong class="priority-gid">'+esc(n.gid)+'</strong><span class="role-label"><i class="dot" style="background:'+color(n.role)+'"></i>'+esc(role(n.role))+'</span><p>'+esc(n.why?.length>180?n.why.slice(0,177)+'…':n.why)+'</p></button>').join('')+'<button class="quiet" data-tab="top">Весь список · '+data.top_nodes.length+' клиентов ↗</button><div class="summary-note"><strong>Проверяем объяснение, а не только скор</strong>Откройте клиента: сопоставьте роль, суммы переводов и круг его связей.</div>';
}
function dossier(n){
 const ranked=data.top_nodes.find(x=>x.gid===n.gid),edges=adj.get(n.gid)||[];
 $('inspector-label').textContent=ranked?'ПРИОРИТЕТ '+String(ranked.rank).padStart(2,'0')+' / '+data.top_nodes.length:'ИССЛЕДОВАНИЕ КЛИЕНТА';$('inspector-close').hidden=false;
 const facts=[['Индекс приоритета',pct(n.priority_score)],['Уверенность роли',pct(n.role_score)],['Входящих переводов',fmt(n.in_tx)],['Исходящих переводов',fmt(n.out_tx)],['Доля пропуска',n.pass_through==null?'Нет входящих':pct(n.pass_through)],['Колено обхода',n.depth],['Исходный клиент',n.is_seed?'Да':'Нет'],['Сообщество',n.cluster_id],['Наблюдение',terminalStatuses[n.terminal_status]?.label||'Не рассчитано']];
 const boundary=n.terminal_status==='unknown_truncated'||n.truncated_by_depth;
 const decision=decisions[n.gid];
 $('dossier').innerHTML='<div class="node-kicker">GID · ИДЕНТИФИКАТОР КЛИЕНТА</div><h1 class="node-id">'+esc(n.gid)+'</h1><span class="hypothesis-label">Предполагаемая роль</span><h2 class="role-heading">'+esc(role(n.role))+'</h2><p class="case-reason">'+esc(ranked?.why||n.why||n.evidence||'Обоснование не предоставлено. Сопоставьте наблюдаемые связи.')+'</p>'+
 (boundary?'<div class="note"><strong>Здесь заканчивается выгрузка.</strong><br>Исходящие за её границей неизвестны. Вероятность конечного получателя: <strong>'+pct(n.terminal_p)+'</strong> по модели.<br><button class="text-button" data-tab="terminal">Почему это важно →</button></div>':'')+
 '<div class="funds-flow"><div><span>↘ ПОСТУПИЛО</span><strong>'+money(n.in_kzt)+'</strong><small>от '+fmt(n.in_deg)+' плательщиков</small></div><div><span>↗ ПЕРЕДАНО ДАЛЬШЕ</span><strong>'+money(n.out_kzt)+'</strong><small>'+fmt(n.out_deg)+' получателям</small></div></div>'+
 (isRemoved(n.gid)?'<p class="note">Узел изъят в текущей симуляции. Исходные данные не изменены.</p>':'')+
 '<div class="inspector-actions"><button id="neighbors">Окружение</button><button id="show-on-map">Положение во всей сети ↗</button></div>'+
 '<details class="case-detail"><summary>Основания и показатели</summary><div class="evidence">'+esc(n.evidence||'Нет дополнительных оснований')+'</div><div class="facts">'+facts.map(([k,v])=>'<div><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div>'+(n.is_seed||n.pass_through>1?'<p class="note">Внешние поступления не видны. Эти суммы не отражают полный баланс клиента.</p>':'')+'</details>'+
 '<details class="case-detail"><summary>Контрагенты и переводы · '+edges.length+'</summary>'+([...edges].sort((a,b)=>b.sum_kzt-a.sum_kzt).map(e=>{const incoming=e.dst===n.gid,other=incoming?e.src:e.dst;return '<button class="neighbor" data-gid="'+esc(other)+'">'+(incoming?'← От ':'→ К ')+esc(other)+'<span>'+money(e.sum_kzt)+' · '+fmt(e.n_tx)+' переводов</span></button>'}).join('')||'<p class="muted">В предоставленной выборке переводов нет. Это не означает отсутствия операций вне неё.</p>')+'</details>';
 $('review-actions').hidden=false;$('review-actions').innerHTML='<div class="case-decision"><button id="mark-check" class="'+(decision==='check'?'primary':'')+'">'+(decision==='check'?'✓ В проверку':'В проверку')+'</button><button id="mark-later">'+(decision==='later'?'✓ Отложен':'Отложить')+'</button></div><p class="decision-note '+(decision?'saved':'')+'">'+(decision?'Метка сохранена в этом браузере. Повторное нажатие снимает её.':'Личная отметка в этом браузере. Не блокирует клиента.')+'</p>';
 const mark=value=>{if(decisions[n.gid]===value)delete decisions[n.gid];else decisions[n.gid]=value;try{localStorage.setItem('money-review',JSON.stringify(decisions))}catch(_){msg('Браузер не разрешил сохранить отметку. Она действует до закрытия страницы.',true)}dossier(n);renderQueue()};
 $('mark-check').onclick=()=>mark('check');$('mark-later').onclick=()=>mark('later');
 $('neighbors').onclick=()=>{tab('network');graph.select(n.gid);updateGraphTitle()};
 $('show-on-map').onclick=()=>{tab('network');graph.select(n.gid);graph.filter('',false);updateGraphTitle();$('graph-title').textContent='Клиент в структуре сети'};
}
function tables(){
 $('top-count').textContent=data.top_nodes.length;$('boundary-count').textContent=fmt(data.nodes.filter(n=>n.terminal_status==='unknown_truncated').length);$('boundary-title').textContent=$('boundary-count').textContent+' клиента. Продолжение неизвестно.';
 $('top-body').innerHTML=data.top_nodes.map(n=>'<tr data-gid="'+esc(n.gid)+'"><td>'+esc(n.rank)+'</td><td><button data-gid="'+esc(n.gid)+'">'+esc(n.gid)+'</button></td><td><i class="dot" style="background:'+color(n.role)+'"></i>'+esc(role(n.role))+'</td><td>'+pct(n.priority_score)+'</td><td>'+esc(n.why)+'</td></tr>').join('')||'<tr><td colspan="5">Приоритеты ещё не рассчитаны.</td></tr>';
 $('cluster-list').innerHTML=data.clusters.map(c=>'<button class="cluster-card" data-cluster="'+esc(c.cluster_id)+'"><strong>Сообщество '+esc(c.cluster_id)+'</strong><span>'+fmt(c.n_nodes)+' клиентов · '+fmt(c.n_seed)+' seed</span><span>Внутренний оборот '+money(c.sum_kzt_internal)+'</span><p>'+esc(c.hypothesis||'Гипотеза ещё не рассчитана')+'</p></button>').join('');
 $('cluster').innerHTML='<option value="">Все сообщества</option>'+[...new Set(data.nodes.map(n=>String(n.cluster_id)))].sort((a,b)=>Number(a)-Number(b)).map(id=>'<option value="'+esc(id)+'">Сообщество '+esc(id)+'</option>').join('');
 $('legend').innerHTML='<span>● Клиент</span><span style="color:var(--accent)">● Выбранный / исходный</span><span>→ Перевод</span>';
}
function setupSimulation(){simulation=buildRemovalSimulation(data.nodes,data.edges,50);removalCount=0;$('remove-count').max=simulation.rankedIds.length;$('remove-count').value=0;$('remove-max').textContent=simulation.rankedIds.length;$('remove-count').disabled=false;updateSimulation()}
function updateSimulation(){
 if(!simulation)return;removalCount=Math.max(0,Math.min(simulation.rankedIds.length,Number($('remove-count').value)||0));const state=simulation.states[removalCount];$('remove-value').textContent=removalCount;$('remove-count').setAttribute('aria-valuetext','Изъято '+removalCount+' узлов');$('sim-components').textContent=fmt(state.components);$('sim-cut').textContent=pct(state.cutShare);
 $('simulation-result').textContent='До изъятия: '+fmt(simulation.states[0].components)+' фрагментов. После: '+fmt(state.components)+'. Затронуто '+money(state.cut)+' переводов. Крупнейший фрагмент — '+fmt(state.largest)+' из '+fmt(state.remaining)+' оставшихся клиентов.';
 $('removed-list').innerHTML=simulation.rankedIds.slice(0,removalCount).map((id,i)=>'<button data-gid="'+esc(id)+'">'+(i+1)+'. '+esc(id)+'</button>').join('')||'Узлы не изъяты.';
 graph.setRemoved(simulation.rankedIds.slice(0,removalCount));if(selected)dossier(byId.get(selected));
}
function validate(next){
 if(!next||!Array.isArray(next.nodes)||!next.nodes.length||!Array.isArray(next.edges)||!Array.isArray(next.top_nodes)||!Array.isArray(next.clusters))throw Error('Файл пуст или не соответствует контракту');
 const ids=new Map(next.nodes.map(n=>[n.gid,n]));
 if(ids.size!==next.nodes.length||next.nodes.some(n=>typeof n.gid!=='string'||!/^\d{18}$/.test(n.gid))||next.top_nodes.some(n=>typeof n.gid!=='string'||!ids.has(n.gid))||next.edges.some(e=>typeof e.src!=='string'||typeof e.dst!=='string'||!ids.has(e.src)||!ids.has(e.dst))||next.clusters.some(c=>!Array.isArray(c.top_gids)||c.top_gids.some(id=>typeof id!=='string'||!ids.has(id))))throw Error('Некорректные идентификаторы или связи. Ожидаются точные строковые gid.');
 if(next.nodes.some(n=>!Number.isFinite(n.x)||!Number.isFinite(n.y)||n.x<0||n.x>1||n.y<0||n.y>1))throw Error('Отсутствуют корректные координаты сети.');
 if(next.edges.some(e=>!Number.isFinite(e.sum_kzt)||e.sum_kzt<0))throw Error('Некорректные суммы переводов.');
 return ids;
}
async function load(options={}){
 if(loading)return;loading=true;$('reload').disabled=true;const quiet=options.quiet===true||!!data,previous={selected,cluster:$('cluster').value,tab:currentTab,removal:removalCount};if(!quiet)msg('Загрузка и проверка данных…');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 try{const response=await fetch('../out/graph.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('HTTP '+response.status);const text=await response.text(),next=JSON.parse(text),signature=text;if(quiet&&signature===fingerprint)return;const ids=validate(next);data=next;byId=ids;fingerprint=signature;adj=new Map(data.nodes.map(n=>[n.gid,[]]));for(const e of data.edges){adj.get(e.src).push(e);if(e.src!==e.dst)adj.get(e.dst).push(e)}
  selected=null;$('stub').hidden=data.meta?.stub!==true;$('data-label').textContent=data.meta?.stub?'Предварительный расчёт':'Расчёт выполнен';$('period-label').textContent=(data.meta?.period==='2026-07-01..2026-07-31'?'Июль 2026':(data.meta?.period||'Период не указан').replace('..',' — '));
  $('metrics').innerHTML=[['Клиентов в сети',fmt(data.nodes.length)],['Исходных · seed',fmt(data.nodes.filter(n=>n.is_seed).length)],['Связей',fmt(data.edges.length)],['Оборот выборки',data.meta?.total_kzt!=null?(data.meta.total_kzt/1e6).toLocaleString('ru-RU',{maximumFractionDigits:1})+' млн ₸':'—']].map(([label,value])=>'<div class="metric"><strong>'+esc(value)+'</strong><span>'+label+'</span></div>').join('');
  tables();renderTerminal();graph.setData(data);setupSimulation();overview();$('graph-loading').hidden=true;$('footer-status').textContent=fmt(data.nodes.length)+' клиентов · '+fmt(data.edges.length)+' связей · KZT';$('case-scope').textContent='Исходных: '+fmt(data.nodes.filter(n=>n.is_seed).length)+' → '+fmt(data.nodes.length)+' клиентов · '+(Number(data.meta?.total_kzt||0)/1e6).toLocaleString('ru-RU',{maximumFractionDigits:1})+' млн ₸';
  if(quiet){restoring=true;$('remove-count').value=Math.min(previous.removal,simulation.rankedIds.length);updateSimulation();if(previous.selected&&byId.has(previous.selected))selectNode(previous.selected,false);else if([...$('cluster').options].some(o=>o.value===previous.cluster)){$('cluster').value=previous.cluster;graph.filter(previous.cluster)}tab(previous.tab,false);restoring=false;msg('Данные обновлены. Выбранный клиент и сценарий сохранены.')}else{restorePosition();savePosition(true)}updateGraphTitle();renderQueue();

 }catch(e){msg((data?'Обновление не удалось; сохранены предыдущие данные. ':'Не удалось открыть граф. ')+'Нажмите «Обновить данные», чтобы повторить. '+(e.name==='AbortError'?'Истекло время ожидания.':e.message),true);if(!data){$('data-label').textContent='Данные недоступны';$('inspector-label').textContent='ЗАГРУЗКА ПРЕРВАНА';$('graph-title').textContent='Не удалось открыть сеть';$('visible-count').textContent='Повторите загрузку кнопкой ↻';$('graph-loading').innerHTML='<strong>Граф пока недоступен</strong><span>Причина показана над рабочей областью.</span>';$('dossier').innerHTML='<p class="note">Данные не загружены. Нажмите ↻ после проверки файла.</p>'}}finally{clearTimeout(timer);loading=false;$('reload').disabled=false}
}
$('search').onsubmit=e=>{e.preventDefault();const id=$('gid').value.trim();if(!data){msg('Дождитесь загрузки данных.',true);return}if(!id){msg('Введите полный gid клиента.',true);return}selectNode(id)};
$('reload').onclick=()=>load({quiet:!!data});$('theme').onclick=()=>{document.body.classList.toggle('dark');try{localStorage.setItem('money-theme',document.body.classList.contains('dark')?'dark':'light')}catch(_){}graph.cacheColors();graph.request()};
$('cluster').onchange=()=>{if(!data)return;overview();graph.selected=null;graph.near.clear();graph.focusEdges.clear();tab('network',false);graph.filter($('cluster').value);updateGraphTitle();savePosition()};
$('reset').onclick=()=>{if(!data)return;$('cluster').value='';overview();tab('network',false);graph.clear();updateGraphTitle();msg('Вся сеть. Откройте клиента из очереди или найдите его по gid.');savePosition()};$('inspector-close').onclick=()=>tab('top');
$('zoom-in').onclick=()=>graph.zoom(1.4);$('zoom-out').onclick=()=>graph.zoom(1/1.4);$('fit').onclick=()=>graph.fit();
$('remove-count').addEventListener('input',()=>{if(simulationFrame)return;simulationFrame=requestAnimationFrame(()=>{simulationFrame=0;updateSimulation();savePosition(true)})});$('simulation-reset').onclick=()=>{$('remove-count').value=0;updateSimulation();savePosition(true)};
document.addEventListener('click',e=>{const g=e.target.closest('[data-gid]'),c=e.target.closest('[data-cluster]'),t=e.target.closest('[data-tab]');if(g)selectNode(g.dataset.gid);if(c){$('cluster').value=c.dataset.cluster;$('cluster').onchange()}if(t)tab(t.dataset.tab)});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('gid').focus();$('gid').select()}});
$('queue-prev').onclick=()=>moveQueue(-1);$('queue-next').onclick=()=>moveQueue(1);
window.addEventListener('popstate',restorePosition);
const mobileLayout=matchMedia('(max-width:760px)'),searchHeader=document.querySelector('.workspace-header');
function placeSearch(){if(mobileLayout.matches)document.querySelector('.workbench').insertBefore(searchHeader,document.querySelector('.workspace'));else document.querySelector('.workspace').prepend(searchHeader)}
mobileLayout.addEventListener('change',placeSearch);placeSearch();
load();setInterval(()=>{if(data&&!document.hidden&&!loading)load({quiet:true})},30000);
