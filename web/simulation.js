'use strict';
/* Reverse activation computes every removal scenario in one union-find pass.
   IDs remain strings; numeric indices are internal array offsets only. */
function buildRemovalSimulation(nodes, edges, limit = 50) {
  const size = nodes.length;
  const index = new Map(nodes.map((node, i) => [String(node.gid), i]));
  const ranked = nodes.slice().sort((a, b) =>
    (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0) ||
    String(a.gid).localeCompare(String(b.gid))).slice(0, limit);
  const count = ranked.length;
  const rankedIds = ranked.map(node => String(node.gid));
  const removedRank = new Map(rankedIds.map((id, i) => [id, i + 1]));
  const parent = new Int32Array(size);
  const weight = new Int32Array(size).fill(1);
  const active = new Uint8Array(size);
  const incident = Array.from({ length: size }, () => []);
  const graphEdges = edges.map(edge => ({
    a: index.get(String(edge.src)), b: index.get(String(edge.dst)),
    amount: Math.max(0, Number(edge.sum_kzt) || 0)
  }));
  let total = 0, kept = 0, components = 0, largest = 0;
  for (let i = 0; i < size; i++) {
    parent[i] = i;
    if (!removedRank.has(String(nodes[i].gid))) { active[i] = 1; components++; largest = 1; }
  }
  function root(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function join(a, b) {
    let ra = root(a), rb = root(b);
    if (ra === rb) return;
    if (weight[ra] < weight[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    weight[ra] += weight[rb];
    largest = Math.max(largest, weight[ra]);
    components--;
  }
  for (const edge of graphEdges) {
    if (edge.a === undefined || edge.b === undefined) throw new Error('Связь с отсутствующим узлом');
    incident[edge.a].push(edge);
    if (edge.b !== edge.a) incident[edge.b].push(edge);
    total += edge.amount;
    if (active[edge.a] && active[edge.b]) { kept += edge.amount; join(edge.a, edge.b); }
  }
  const states = new Array(count + 1);
  function save(n) {
    const cut = n === 0 ? 0 : Math.max(0, total - kept);
    states[n] = { removed: n, remaining: size - n, components, largest,
      cut, cutShare: total > 0 ? cut / total : 0, total };
  }
  save(count);
  for (let n = count; n > 0; n--) {
    const i = index.get(rankedIds[n - 1]);
    active[i] = 1;
    components++;
    largest = Math.max(largest, 1);
    for (const edge of incident[i]) {
      if (active[edge.a] && active[edge.b]) { kept += edge.amount; join(edge.a, edge.b); }
    }
    save(n - 1);
  }
  return { states, rankedIds, removedRank };
}
if (typeof module !== 'undefined') module.exports = { buildRemovalSimulation };
