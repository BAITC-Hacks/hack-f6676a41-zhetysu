'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildRemovalSimulation } = require('../simulation.js');
function reference(nodes, edges, ids) {
 const removed=new Set(ids), active=nodes.filter(n=>!removed.has(String(n.gid)));
 const adj=new Map(active.map(n=>[String(n.gid),[]]));
 let total=0,cut=0,components=0,largest=0;
 for(const e of edges){total+=e.sum_kzt;if(removed.has(String(e.src))||removed.has(String(e.dst)))cut+=e.sum_kzt;else{adj.get(String(e.src)).push(String(e.dst));adj.get(String(e.dst)).push(String(e.src));}}
 const visited=new Set();
 for(const id of adj.keys()){if(visited.has(id))continue;components++;let size=0;const stack=[id];visited.add(id);while(stack.length){const current=stack.pop();size++;for(const other of adj.get(current)){if(!visited.has(other)){visited.add(other);stack.push(other)}}}largest=Math.max(largest,size)}
 return {components,largest,cut,total};
}
function check(nodes,edges){const result=buildRemovalSimulation(nodes,edges);for(let n=0;n<result.states.length;n++){const expected=reference(nodes,edges,result.rankedIds.slice(0,n)),actual=result.states[n];assert.equal(actual.components,expected.components);assert.equal(actual.largest,expected.largest);assert.ok(Math.abs(actual.cut-expected.cut)<.001);assert.equal(actual.remaining,nodes.length-n);assert.ok(actual.cutShare>=0&&actual.cutShare<=1.000000001)}return result;}
// Bidirectional edges, self-loops, ties, isolated clients, empty and fully removed graphs.
const nodes=['100000000000000001','100000000000000002','100000000000000003','100000000000000004'].map((gid,i)=>({gid,priority_score:i===3?0:1}));
check(nodes,[{src:nodes[0].gid,dst:nodes[1].gid,sum_kzt:100},{src:nodes[1].gid,dst:nodes[0].gid,sum_kzt:50},{src:nodes[0].gid,dst:nodes[0].gid,sum_kzt:25},{src:nodes[1].gid,dst:nodes[2].gid,sum_kzt:0}]);
check(nodes,[]);check([],[]);
let seed=7;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32};
for(let trial=0;trial<50;trial++){const ns=Array.from({length:1+Math.floor(random()*80)},(_,i)=>({gid:'node-'+i,priority_score:random()}));const es=Array.from({length:Math.floor(random()*150)},()=>({src:ns[Math.floor(random()*ns.length)].gid,dst:ns[Math.floor(random()*ns.length)].gid,sum_kzt:Math.floor(random()*10000)/100}));check(ns,es)}
const real=JSON.parse(fs.readFileSync(new URL('../../out/graph.json','file://'+__filename),'utf8'));
const start=performance.now();const result=buildRemovalSimulation(real.nodes,real.edges);const ms=performance.now()-start;check(real.nodes,real.edges);
console.log(JSON.stringify({checks:'all states vs independent BFS; 50 generated graphs and current graph',precomputeMs:+ms.toFixed(2),baseline:result.states[0],top50:result.states.at(-1)},null,2));
