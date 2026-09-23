'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {summarizeTerminal}=require('../terminal.js');
const nodes=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../out/graph.json'),'utf8')).nodes;
const s=summarizeTerminal(nodes);
assert.equal(Object.values(s.counts).reduce((a,b)=>a+b,0)+s.missing,nodes.length);
assert.equal(s.naive,nodes.filter(n=>n.in_kzt>0&&n.out_deg===0).length);
assert.equal(s.corrected,nodes.filter(n=>n.terminal_status==='observed_sink'||n.terminal_status==='unknown_truncated'&&n.role==='terminal').length);
assert.equal(s.estimated,nodes.filter(n=>n.terminal_status==='unknown_truncated'&&n.role==='terminal').length);
assert.equal(s.terminalRoles,nodes.filter(n=>n.role==='terminal').length);
assert.ok(s.truncated.every((n,i)=>i===0||(s.truncated[i-1].terminal_p??-1)>=(n.terminal_p??-1)));
const fixture=summarizeTerminal([
 {gid:'100000000000000001',terminal_status:'unknown_truncated',terminal_p:0,role:'peripheral',in_kzt:100,out_deg:0},
 {gid:'100000000000000002',terminal_status:'unknown_truncated',terminal_p:null,role:'peripheral',in_kzt:100,out_deg:0},
 {gid:'100000000000000003',terminal_status:'observed_sink',terminal_p:1,role:'coordinator',in_kzt:100,out_deg:0},
 {gid:'100000000000000004',terminal_status:'future_status',role:'peripheral',in_kzt:0,out_deg:0}
]);
assert.equal(fixture.estimated,0);assert.equal(fixture.missing,1);assert.equal(fixture.corrected,1);assert.equal(fixture.truncated[0].terminal_p,0);assert.equal(summarizeTerminal([]).corrected,0);
console.log(JSON.stringify({counts:s.counts,naive:s.naive,corrected:s.corrected,estimated:s.estimated,terminalRoles:s.terminalRoles}));
