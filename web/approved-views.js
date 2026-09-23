(function () {
  'use strict';

  const roles = {
    coordinator: 'Координатор', consolidator: 'Точка консолидации',
    distributor: 'Распределитель', transit: 'Транзит',
    terminal: 'Конечный получатель', peripheral: 'Периферия'
  };
  const statuses = { none: 'Без отметки', check: 'В проверке', later: 'Отложен' };
  const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const percentFormat = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = value => Number.isFinite(value) ? numberFormat.format(value) : '—';
  const pct = value => Number.isFinite(value) ? percentFormat.format(value) : '—';
  const money = value => {
    if (!Number.isFinite(value)) return '—';
    return value >= 1e6 ? `${num(value / 1e6)} млн ₸` : value >= 1e3 ? `${num(value / 1e3)} тыс. ₸` : `${num(value)} ₸`;
  };
  const icon = name => typeof window.approvedIcon === 'function' ? window.approvedIcon(name) : '';
  const node = (ctx, gid) => ctx.byId instanceof Map ? ctx.byId.get(gid) : ctx.byId?.[gid];
  const mark = (ctx, gid) => Object.hasOwn(statuses, ctx.marks?.[gid]) ? ctx.marks[gid] : 'none';
  const role = value => roles[value] || value || 'Роль не определена';
  const queueAll = ctx => (ctx.data.top_nodes || []).slice().sort((a, b) => a.rank - b.rank).slice(0, 30);
  const queueFiltered = ctx => {
    const query = (ctx.queueQuery || '').trim().toLocaleLowerCase('ru');
    return queueAll(ctx).filter(v => (!query || `${v.gid} ${role(v.role)}`.toLocaleLowerCase('ru').includes(query)) &&
      (!ctx.queueRole || v.role === ctx.queueRole) && (!ctx.queueStatus || mark(ctx, v.gid) === ctx.queueStatus));
  };

  function queueRows(ctx) {
    return queueFiltered(ctx).map(v => {
      const n = node(ctx, v.gid) || v;
      const why = String(v.why || n.why || n.evidence || 'Развёрнутое основание в выгрузке отсутствует.').split(/\.\s*Поднят по:/)[0];
      return `<tr><td><span class="queue-rank ${v.rank <= 3 ? 'top' : ''}">${String(v.rank).padStart(2, '0')}</span></td>
        <td><button class="table-client mono" data-gid="${esc(v.gid)}" title="Открыть досье ${esc(v.gid)}">${esc(v.gid)}</button><div class="tiny muted" style="margin-top:5px">Приоритет ${pct(v.priority_score)}</div></td>
        <td style="white-space:normal;min-width:135px">${esc(role(v.role))}</td>
        <td style="white-space:normal;min-width:260px;max-width:420px;line-height:1.65">${esc(why)}${n.terminal_status === 'unknown_truncated' ? '<div class="pill amber" style="margin-top:6px">Исходящие не наблюдались</div>' : ''}</td>
        <td><select data-status-gid="${esc(v.gid)}" aria-label="Статус клиента ${esc(v.gid)}">${Object.entries(statuses).map(([key, label]) => `<option value="${key}" ${mark(ctx, v.gid) === key ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
        <td><button class="icon-button" data-gid="${esc(v.gid)}" aria-label="Открыть досье ${esc(v.gid)}">${icon('arrowRight')}</button></td></tr>`;
    }).join('') || '<tr><td colspan="6"><div class="empty-state">По вашим фильтрам ничего не найдено. Измените GID, роль или статус.</div></td></tr>';
  }

  function queueFooter(ctx) {
    return `Показано ${queueFiltered(ctx).length} из ${queueAll(ctx).length} клиентов · порядок по индексу приоритета`;
  }

  function queue(ctx) {
    const all = queueAll(ctx);
    return `<section class="secondary-view"><div class="mini-stats"><div class="mini-stat"><strong>${all.length}</strong><span>Клиентов в очереди приоритета</span></div><div class="mini-stat"><strong id="queue-check-count">${all.filter(v => mark(ctx, v.gid) === 'check').length}</strong><span>Отмечено для проверки</span></div><div class="mini-stat"><strong id="queue-later-count">${all.filter(v => mark(ctx, v.gid) === 'later').length}</strong><span>Отложено в этом браузере</span></div></div>
      <div class="panel"><div class="section-toolbar"><div class="row"><label class="sr-only" for="queue-search">Поиск в очереди</label><input id="queue-search" placeholder="Поиск по GID или роли" value="${esc(ctx.queueQuery)}" autocomplete="off"><label class="sr-only" for="queue-role">Роль клиента</label><select id="queue-role"><option value="">Все роли</option>${[...new Set(all.map(v => v.role))].map(value => `<option value="${esc(value)}" ${ctx.queueRole === value ? 'selected' : ''}>${esc(role(value))}</option>`).join('')}</select><label class="sr-only" for="queue-status">Статус</label><select id="queue-status"><option value="">Все статусы</option>${Object.entries(statuses).map(([key, label]) => `<option value="${key}" ${ctx.queueStatus === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><span class="small muted">В первую очередь — основания проверки</span></div>
      <div class="table-wrap" style="max-height:calc(100vh - 430px);min-height:260px"><table class="queue-table"><thead><tr><th>№</th><th>GID клиента</th><th>Предполагаемая роль</th><th>Основание для проверки</th><th>Личный статус</th><th><span class="sr-only">Досье</span></th></tr></thead><tbody id="queue-rows">${queueRows(ctx)}</tbody></table></div><div class="table-footer" id="queue-table-footer">${queueFooter(ctx)}</div></div>
      <div class="notice neutral" style="margin-top:0">Индекс помогает выбрать порядок проверки. Он не является вероятностью нарушения. Личные статусы сохраняются только в этом браузере и не блокируют клиентов.</div></section>`;
  }

  function communityGrid(ctx) {
    const query = (ctx.communityQuery || '').trim().toLocaleLowerCase('ru');
    const clusters = ctx.data.clusters.slice().sort((a, b) => b.sum_kzt_internal - a.sum_kzt_internal || b.n_nodes - a.n_nodes)
      .filter(c => !query || String(c.cluster_id).includes(query) || (c.cluster_id === -1 && 'без связей'.includes(query)));
    return clusters.map(c => `<button class="community-card ${c.n_coordinator ? 'known' : ''}" data-community="${esc(c.cluster_id)}" aria-label="Открыть ${c.cluster_id === -1 ? 'клиентов без связей' : `сообщество ${c.cluster_id}`}">${icon('users')}<span class="pill ${c.n_coordinator ? 'green' : ''}">${num(c.n_nodes)} клиентов</span><h3>${c.cluster_id === -1 ? 'Без связей · −1' : `Сообщество ${esc(c.cluster_id)}`}</h3><p style="font-size:13px;color:var(--ink);margin-top:10px">${money(c.sum_kzt_internal)}</p><p>Внутренний оборот · ${num(c.n_seed)} исходных</p><p style="line-height:1.7">${num(c.n_consolidator)} точек сбора · ${num(c.n_transit)} транзитных</p>${c.n_truncated ? `<p class="amber">${num(c.n_truncated)} на границе выгрузки</p>` : ''}</button>`).join('') || '<div class="empty-state">Сообщество не найдено. Введите другой номер.</div>';
  }

  function communities(ctx) {
    return `<section class="secondary-view"><div class="panel"><div class="view-intro"><div class="row spread"><h2>Сообщества сети</h2><span class="pill green">${num(ctx.data.clusters.length)} групп</span></div><p>Группы клиентов со связанными переводами. Откройте сообщество, чтобы изучить его состав и окружение приоритетного клиента. Порядок — по внутреннему обороту; принадлежность к группе сама по себе не указывает на нарушение.</p></div><div class="section-toolbar"><h3>Связанные группы</h3><label class="sr-only" for="community-search">Номер сообщества</label><input id="community-search" placeholder="Найти номер сообщества" value="${esc(ctx.communityQuery)}" inputmode="numeric" autocomplete="off"></div><div class="community-grid" id="community-grid">${communityGrid(ctx)}</div></div></section>`;
  }

  function boundaries(ctx) {
    const nodes = ctx.data.nodes;
    const boundary = nodes.filter(n => n.terminal_status === 'unknown_truncated').sort((a, b) => (b.terminal_p ?? -1) - (a.terminal_p ?? -1) || a.gid.localeCompare(b.gid));
    const count = key => nodes.filter(n => n.terminal_status === key).length;
    const pages = Math.max(1, Math.ceil(boundary.length / 20));
    const page = Math.max(0, Math.min(pages - 1, Math.trunc(Number(ctx.boundaryPage) || 0)));
    const method = ctx.data.meta?.method?.censoring || {};
    const estimate = method['ожидаемо_настоящих_конечных'];
    const terminal = boundary.filter(n => n.role === 'terminal').length;
    return `<section class="secondary-view"><div class="bound-note">${icon('warning')}<div><strong>${num(boundary.length)} клиентов на границе. Продолжение потока неизвестно.</strong><p>Обход остановился на четвёртом колене. Отсутствие исходящих в выгрузке не означает, что деньги остались у клиента. Для этих узлов показываем оценку вероятности, а не установленный факт.</p></div></div>
      <div class="information-grid"><section class="panel information-card"><h3>Что наблюдается в переводах</h3>${[
        ['Нет исходящих в пределах наблюдения', count('observed_sink'), 'green'],
        ['Передают средства дальше', count('observed_forwarder'), 'green'],
        ['Исходящие за границей обхода', boundary.length, 'amber'],
        ['Без связей в выгрузке', count('no_edges'), '']
      ].map(([label, value, color]) => `<div class="availability-row"><span>${label}</span><span class="pill ${color}">${num(value)}</span></div>`).join('')}<p>Статус наблюдения описывает доступность переводов, а предполагаемая роль — положение клиента в сети. Это разные признаки.</p></section>
      <section class="panel information-card"><h3>Вероятность вместо уверенного вывода</h3><p>${Number.isFinite(estimate) ? `По сумме вероятностей ожидается около <strong>${num(estimate)}</strong> конечных получателей среди ${num(boundary.length)} обрезанных узлов. ` : ''}Оценка использует доступный входящий профиль клиента.</p><p><strong>${num(terminal)}</strong> узлам на границе присвоена предполагаемая роль конечного получателя по порогу модели. Это гипотеза для дополнительной проверки.</p>${Number.isFinite(method.auc_out_of_depth) ? `<div class="availability-row"><span>AUC при проверке на другой глубине</span><span class="pill">${num(method.auc_out_of_depth * 100)}%</span></div>` : ''}<p>Чтобы подтвердить удержание средств, нужны исходящие переводы за границей обхода и за пределами периода.</p></section></div>
      <section class="panel" style="margin-top:16px"><div class="section-toolbar"><div><h3>Клиенты на границе</h3><p class="tiny muted" style="margin-top:5px">По убыванию вероятности конечного получателя</p></div><span class="pill amber">${num(boundary.length)} клиентов</span></div><div class="table-wrap"><table><thead><tr><th>GID клиента</th><th class="amount">Поступило</th><th class="amount">Плательщиков</th><th class="amount">Вероятность роли</th><th>Предполагаемая роль</th></tr></thead><tbody id="boundary-rows">${boundary.slice(page * 20, page * 20 + 20).map(n => `<tr><td><button class="table-client mono" data-gid="${esc(n.gid)}">${esc(n.gid)}</button></td><td class="amount">${money(n.in_kzt)}</td><td class="amount muted">${num(n.in_deg)}</td><td class="amount"><span class="pill ${Number.isFinite(n.terminal_p) && n.terminal_p >= 0.7 ? 'amber' : ''}" title="Оценка вероятности конечного получателя; не вероятность нарушения">${pct(n.terminal_p)}</span></td><td style="white-space:normal">${esc(role(n.role))}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">В этой выгрузке нет клиентов с обрезанным обходом.</div></td></tr>'}</tbody></table></div><div class="table-footer row spread"><span>Страница ${page + 1} из ${pages} · ${boundary.length ? page * 20 + 1 : 0}–${Math.min((page + 1) * 20, boundary.length)} из ${num(boundary.length)}</span><div class="row"><button class="button compact" data-boundary-page="${page - 1}" ${page === 0 ? 'disabled' : ''} aria-label="Предыдущая страница">${icon('arrowLeft')}Назад</button><button class="button compact" data-boundary-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''} aria-label="Следующая страница">Далее${icon('arrowRight')}</button></div></div></section>
      <div class="notice neutral">Суммы отражают только наблюдаемые переводы. Предполагаемая роль и вероятность не устанавливают виновность и не являются основанием для автоматической блокировки.</div></section>`;
  }

  function scenarioState(ctx) {
    const maximum = Math.min(50, ctx.simulation?.rankedIds?.length || 0);
    const removed = Math.max(0, Math.min(maximum, Math.trunc(Number(ctx.removeCount) || 0)));
    return { maximum, removed, result: ctx.simulation?.states?.[removed] };
  }

  function scenarioResult(ctx) {
    const { removed, result } = scenarioState(ctx);
    if (!result) return '<div class="empty-state">Расчёт связности пока недоступен. Повторите загрузку материалов.</div>';
    const robust = ctx.data.meta?.robustness;
    const index = robust?.n_removed?.indexOf(removed) ?? -1;
    const randomCut = index >= 0 ? robust?.random_mean?.cut_kzt_share?.[index] : null;
    const randomComponents = index >= 0 ? robust?.random_mean?.n_components?.[index] : null;
    const targetedReach = index >= 0 ? robust?.targeted?.seed_reach_kzt_share?.[index] : null;
    const randomReach = index >= 0 ? robust?.random_mean?.seed_reach_kzt_share?.[index] : null;
    const comparison = Number.isFinite(randomCut) && Number.isFinite(randomComponents) ? `<div class="divider"></div><h3 style="margin-bottom:9px">При случайном изъятии ${removed} узлов</h3><div class="availability-row"><span>Среднее число фрагментов</span><strong>${num(randomComponents)}</strong></div><div class="availability-row"><span>Затронутый оборот</span><strong>${pct(randomCut)}</strong></div>${Number.isFinite(targetedReach) && Number.isFinite(randomReach) ? `<div class="availability-row"><span>Оборот на маршрутах от исходных клиентов<br><small class="muted">По приоритету / случайно</small></span><strong style="white-space:nowrap">${pct(targetedReach)} / ${pct(randomReach)}</strong></div>` : ''}<p class="tiny" style="margin-bottom:0">${esc(robust['метод'] || 'Сравнение с расчётом случайного изъятия из исходных материалов.')}</p>` : '';
    return `<h2>Результат сценария</h2><div class="scenario-metrics"><div class="scenario-metric"><strong id="scenario-components">${num(result.components)}</strong><span>Слабосвязных фрагментов</span></div><div class="scenario-metric"><strong id="scenario-turnover">${pct(result.cutShare)}</strong><span>Наблюдаемого оборота затронуто</span></div></div><p id="scenario-description">Осталось ${num(result.remaining)} из ${num(ctx.data.nodes.length)} клиентов. Крупнейший фрагмент: ${num(result.largest)}. Затронуто ${money(result.cut)} из ${money(result.total)} переводов.</p><div class="notice" id="scenario-warning">Сценарий оценивает структуру сети. Затронутый оборот — сумма связей с исключёнными узлами, а не предотвращённые потери. Каждый перевод учитывается один раз.</div>${comparison}`;
  }

  function removedList(ctx) {
    const { removed } = scenarioState(ctx);
    return (ctx.simulation?.rankedIds || []).slice(0, removed).map(gid => `<button class="text-button mono" data-gid="${esc(gid)}" title="Открыть досье ${esc(gid)}"><span>${esc(gid)}</span></button>`).join('') || '<span style="font-family:var(--font)">Узлы не исключены</span>';
  }

  function scenarios(ctx) {
    const { maximum, removed, result } = scenarioState(ctx);
    return `<section class="secondary-view"><div class="scenario-layout"><section class="panel scenario-card"><div class="row spread"><h2>Изъятие узлов</h2><span class="pill">Исследовательский сценарий</span></div><p>Что происходит со связностью сети, если исключить первых N клиентов по приоритету. Сценарий не изменяет исходные данные и не выполняет банковские операции.</p><div class="availability-row"><span>Область расчёта</span><span class="pill green">Вся сеть · ${num(ctx.data.nodes.length)} клиентов</span></div><div class="slider-label"><label for="remove-count">Исключить первые <span id="remove-caption">узлы по приоритету</span></label><output id="remove-value" for="remove-count">${removed}</output></div><input type="range" class="scenario-slider" id="remove-count" min="0" max="${maximum}" step="1" value="${removed}" aria-label="Количество исключаемых узлов" aria-valuetext="Исключить ${removed} узлов" ${!result ? 'disabled' : ''}><div class="range-labels"><span>0</span><button class="text-button" data-action="reset-scenario">Сбросить</button><span id="remove-max">${maximum}</span></div><div class="notice neutral" id="scenario-method">Клиенты ранжируются по индексу приоритета. Исключаются узлы и все их входящие и исходящие связи. Фрагменты рассчитываются без учёта направления перевода; направления сохраняются в анализе маршрутов от исходных клиентов.</div></section><section class="panel scenario-card" id="scenario-result" aria-live="polite" aria-atomic="true">${scenarioResult(ctx)}</section></div><section class="panel scenario-card" style="margin-top:16px"><div class="row spread"><h3>Исключаемые узлы</h3><span class="small muted" id="removed-basis">По индексу приоритета · нажмите для досье</span></div><div class="scenario-list" id="removed-list">${removedList(ctx)}</div></section></section>`;
  }

  window.ApprovedViews = { queue, communities, boundaries, scenarios, queueRows, queueFooter, communityGrid, scenarioResult, removedList };
})();
