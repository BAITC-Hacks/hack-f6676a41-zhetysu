'use strict';
const terminalStatuses = {
  observed_sink: { label: 'Наблюдаемый сток', color: '#d15a70', hint: 'Есть поступления, исходящих в выборке нет; обход здесь не обрывался.' },
  observed_forwarder: { label: 'Передаёт дальше', color: '#2587c8', hint: 'В выборке наблюдаются исходящие переводы.' },
  unknown_truncated: { label: 'Обрыв обхода · неизвестно', color: '#d98618', hint: 'Исходящие за границей глубины не выгружались. Отсутствие ребра не означает удержание денег.' },
  no_edges: { label: 'Без связей', color: '#8796a8', hint: 'В предоставленной сети нет ни входящих, ни исходящих связей.' }
};
function summarizeTerminal(nodes) {
  const counts = Object.fromEntries(Object.keys(terminalStatuses).map(key => [key, 0]));
  let missing = 0, naive = 0, terminalRoles = 0, estimated = 0, observedOtherRoles = 0, forwardingTerminals = 0;
  const truncated = [];
  for (const node of nodes) {
    if (Object.hasOwn(counts, node.terminal_status)) counts[node.terminal_status]++;
    else missing++;
    if (node.in_kzt > 0 && node.out_deg === 0) naive++;
    if (node.role === 'terminal') terminalRoles++;
    if (node.terminal_status === 'observed_sink' && node.role !== 'terminal') observedOtherRoles++;
    if (node.terminal_status === 'observed_forwarder' && node.role === 'terminal') forwardingTerminals++;
    if (node.terminal_status === 'unknown_truncated') {
      truncated.push(node);
      if (node.role === 'terminal') estimated++;
    }
  }
  truncated.sort((a,b) => (b.terminal_p ?? -1) - (a.terminal_p ?? -1) || String(a.gid).localeCompare(String(b.gid)));
  return { counts, missing, naive, terminalRoles, estimated, observedOtherRoles, forwardingTerminals,
    corrected: counts.observed_sink + estimated, truncated };
}
if (typeof module !== 'undefined') module.exports = { summarizeTerminal, terminalStatuses };
