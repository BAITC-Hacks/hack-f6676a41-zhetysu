/* Client dossier in the approved design. GIDs remain strings at every boundary. */
(function () {
  'use strict';

  const STATUSES = { none: 'Не рассмотрен', check: 'В проверке', later: 'Отложен' };
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const percentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const preciseFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = value => finite(value) ? numberFormat.format(value) : '—';
  const money = value => finite(value) ? `${format(value)} ₸` : 'Нет данных';
  const percent = value => finite(value) ? percentFormat.format(value * 100) : '—';
  const icon = name => typeof window.approvedIcon === 'function' ? window.approvedIcon(name) : '';
  const lookup = (collection, key) => collection instanceof Map ? collection.get(key) : collection && collection[key];
  const short = id => `…${id.slice(-9)}`;

  function linksFor(ctx, id) {
    const stored = lookup(ctx.adj, id);
    if (Array.isArray(stored) && stored.every(edge => edge && typeof edge.src === 'string' && typeof edge.dst === 'string')) return stored;
    return (ctx.data.edges || []).filter(edge => edge.src === id || edge.dst === id);
  }

  function flowRow(incoming, amount, caption) {
    return `<div class="flow-item"><span class="direction-icon ${incoming ? 'in' : ''}">${icon(incoming ? 'downLeft' : 'upRight')}</span><div class="flow-text"><span>${incoming ? 'Поступило' : 'Передано дальше'}</span><small>${escape(caption)}</small></div><strong>${money(amount)}</strong></div>`;
  }

  function score(label, value, secondary) {
    const width = finite(value) ? Math.max(0, Math.min(100, value * 100)) : 0;
    return `<div class="score-box${secondary ? ' secondary' : ''}"><small>${escape(label)}</small><strong>${percent(value)}${finite(value) ? '<span>%</span>' : ''}</strong><div class="score-track"><span style="width:${width}%"></span></div></div>`;
  }

  function terminalNotice(node) {
    if (node.terminal_status === 'unknown_truncated') {
      return `<div class="notice"><div class="row">${icon('warning')}Граница выгрузки · колено ${format(node.depth)}</div>Исходящие этого клиента не исследованы: обход остановлен. ${finite(node.terminal_p) ? `Модельная вероятность конечного получателя — <strong>${percent(node.terminal_p)}%</strong>.` : 'Модельная вероятность не рассчитана.'} Это оценка, а не подтверждение конечной роли.<br><button class="text-button" data-view="boundaries">Почему важны границы данных ${icon('arrowRight')}</button></div>`;
    }
    if (node.terminal_status === 'no_edges') {
      return `<div class="notice neutral"><div class="row">${icon('info')}Переводы не найдены</div>В этой выгрузке у клиента нет связей. Нулевые обороты не описывают его операции вне выборки.</div>`;
    }
    if (finite(node.unseen_inflow_kzt) && node.unseen_inflow_kzt > 0) {
      return `<div class="notice"><div class="row">${icon('warning')}Внешние поступления не видны</div>Исходящие превышают видимые поступления на <strong>${money(node.unseen_inflow_kzt)}</strong>. Это разница внутри выборки, а не полный баланс клиента.</div>`;
    }
    if (node.terminal_status === 'observed_sink') {
      return `<div class="notice neutral"><div class="row">${icon('info')}Нет наблюдаемых исходящих</div>Отсутствие исходящих проверено обходом за период выгрузки. За его пределами операции неизвестны.</div>`;
    }
    return '';
  }

  function facts(node) {
    const terminalLabels = {
      observed_sink: 'Исходящие не обнаружены обходом',
      observed_forwarder: 'Исходящие наблюдаются',
      unknown_truncated: 'Исходящие не исследованы',
      no_edges: 'Связей в выгрузке нет'
    };
    const entries = [
      ['Колено обхода', format(node.depth)],
      ['Исходный клиент', node.is_seed ? 'Да' : 'Нет'],
      ['Плательщиков', format(node.in_deg)],
      ['Получателей', format(node.out_deg)],
      ['Входящих переводов', format(node.in_tx)],
      ['Исходящих переводов', format(node.out_tx)],
      ['Плательщиков из исходного списка', format(node.n_seed_payers)],
      ['Исходящие / входящие', finite(node.pass_through) ? `${percent(node.pass_through)}%` : 'Не рассчитывается'],
      ['Разница входа и выхода, ≥ 0', money(node.retained_kzt)],
      ['Невидимый вход, минимум', money(node.unseen_inflow_kzt)],
      ['Медиана до выхода', finite(node.hold_days_median) ? `${format(node.hold_days_median)} дн.` : 'Не рассчитывается'],
      ['Доля быстрого выхода', finite(node.fast_out_share) ? `${percent(node.fast_out_share)}%` : 'Не рассчитывается'],
      ['Плательщиков за один день, максимум', format(node.max_same_day_payers)],
      ['Переводов от одного за день, максимум', format(node.max_same_day_one_payer_tx)],
      ['Достижимых узлов ниже', format(node.downstream_nodes)],
      ['Размер связного фрагмента', format(node.component_size)],
      ['Точка разрыва связности', node.is_articulation ? 'Да' : 'Нет'],
      ['PageRank', finite(node.pagerank) ? preciseFormat.format(node.pagerank) : '—'],
      ['Посредничество', finite(node.betweenness) ? preciseFormat.format(node.betweenness) : '—'],
      ['Оценка хаба', finite(node.hub) ? preciseFormat.format(node.hub) : '—'],
      ['Оценка авторитета', finite(node.authority) ? preciseFormat.format(node.authority) : '—'],
      ['Временной показатель', finite(node.timing_score) ? `${percent(node.timing_score)}%` : '—'],
      ['Наблюдаемость', terminalLabels[node.terminal_status] || 'Не указана']
    ];
    if (node.terminal_status === 'unknown_truncated') entries.push(['P(конечный), оценка модели', finite(node.terminal_p) ? `${percent(node.terminal_p)}%` : 'Не рассчитана']);
    return entries.map(([label, value]) => `<div><small>${escape(label)}</small><strong>${escape(value)}</strong></div>`).join('');
  }

  function overview(ctx, node) {
    const incoming = finite(node.in_kzt) ? node.in_kzt : 0;
    const outgoing = finite(node.out_kzt) ? node.out_kzt : 0;
    const total = incoming + outgoing;
    const inShare = total > 0 ? incoming / total * 100 : 0;
    const outShare = total > 0 ? outgoing / total * 100 : 0;
    const ranked = (ctx.data.top_nodes || []).find(item => item.gid === node.gid);
    const evidence = typeof node.evidence === 'string' ? node.evidence.split(/\s*\|\s*/).filter(Boolean) : [];
    const flags = [
      [node.flag_fast_transit, 'Быстрый транзит'],
      [node.flag_sync_collection, 'Синхронный сбор'],
      [node.flag_structuring, 'Признак дробления']
    ].filter(([active]) => active).map(([, label]) => `<span class="pill amber">${label}</span>`).join('');
    const removed = ctx.removedIds && ctx.removedIds.has(node.gid);
    // The export sometimes truncates the ranking suffix mid-sentence. Its factual
    // explanation is complete before that suffix; never invent the missing words.
    const why = typeof node.why === 'string' ? node.why.split('. Поднят по:')[0] : '';
    return `${removed ? `<div class="notice"><div class="row">${icon('info')}Исключён только в сценарии</div>Досье показывает исходные наблюдаемые переводы. Банковские операции не изменяются.</div>` : ''}
      ${ranked ? `<div class="row spread" style="margin-bottom:14px"><span class="small muted">Позиция в очереди</span><span class="pill green">№ ${format(ranked.rank)} из ${format(ctx.data.top_nodes.length)}</span></div>` : ''}
      <div class="score-row">${score('Индекс приоритета', node.priority_score, false)}${score('Уверенность роли', node.role_score, true)}</div>
      <h3 class="inspector-section-title">Наблюдаемый поток</h3>
      ${flowRow(true, node.in_kzt, `${format(node.in_deg)} плательщиков · ${format(node.in_tx)} переводов`)}
      ${flowRow(false, node.out_kzt, `${format(node.out_deg)} получателей · ${format(node.out_tx)} переводов`)}
      <div class="flow-ratio" aria-label="Объём поступлений и исходящих относительно их суммы"><span class="incoming" style="width:${inShare}%"></span><span class="outgoing" style="width:${outShare}%"></span></div><div class="flow-ratio-caption"><span>Поступления</span><span>Исходящие</span></div>
      <div class="divider"></div><h3 class="inspector-section-title">Основания для проверки</h3>
      ${flags ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:12px" aria-label="Наблюдаемые признаки для проверки">${flags}</div>` : ''}
      ${evidence.length ? evidence.map((text, index) => `<div class="observation">${icon(index ? 'clock' : 'route')}<span>${escape(text)}</span></div>`).join('') : `<div class="observation">${icon('info')}<span>В выгрузке нет текстового основания для этой роли.</span></div>`}
      ${terminalNotice(node)}
      <details class="evidence-details"><summary>Все показатели и основания</summary><div class="facts-grid">${facts(node)}</div>
      ${why ? `<h3 class="inspector-section-title" style="margin-top:18px">Почему в очереди</h3><p class="tiny muted" style="line-height:1.8;overflow-wrap:anywhere">${escape(why)}</p>` : ''}
      ${node.rule_id ? `<p class="tiny muted" style="line-height:1.8;margin-top:12px;overflow-wrap:anywhere"><strong>Правило роли:</strong> ${escape(node.rule_id)}</p>` : ''}
      <div class="notice neutral">Предполагаемая роль и её уверенность — гипотеза по структуре переводов. Индекс приоритета не является вероятностью нарушения и не служит основанием для блокировки.</div></details>`;
  }

  function transfers(ctx, node) {
    const links = linksFor(ctx, node.gid).slice().sort((left, right) => (right.sum_kzt || 0) - (left.sum_kzt || 0));
    return `<div class="row spread"><h3 class="inspector-section-title">Наблюдаемые направления</h3><span class="tiny muted">${format(links.length)}</span></div><p class="tiny muted" style="margin-bottom:10px">Все связи клиента в выгрузке. Суммы агрегированы по направлению; даты отдельных переводов здесь не представлены.</p>${links.map(edge => {
      const incoming = edge.dst === node.gid;
      const other = incoming ? edge.src : edge.dst;
      if (typeof other !== 'string') return '';
      return `<div class="inspector-transfer"><span class="direction-icon ${incoming ? 'in' : ''}">${icon(incoming ? 'downLeft' : 'upRight')}</span><div class="transfer-info"><button class="text-button mono" data-gid="${escape(other)}" aria-label="Открыть досье клиента ${escape(other)}" title="${escape(other)}">${escape(short(other))}</button><small>${incoming ? 'От контрагента' : 'Контрагенту'} · ${format(edge.n_tx)} перев.</small></div><strong class="transfer-amount">${money(edge.sum_kzt)}</strong></div>`;
    }).join('') || '<div class="empty-state">У этого клиента нет наблюдаемых переводов в выгрузке.</div>'}`;
  }

  function notes(ctx, id) {
    const stored = lookup(ctx.notes, id);
    const note = typeof stored === 'string' ? stored : '';
    return `<h3 class="inspector-section-title">Заметка аналитика</h3><label class="sr-only" for="client-note">Заметка о клиенте ${escape(id)}</label><textarea class="note-field" id="client-note" data-note-gid="${escape(id)}" placeholder="Что стоит проверить? Добавьте наблюдения и следующий шаг…" maxlength="10000">${escape(note)}</textarea><div class="notes-label"><span id="note-save-state">${note ? 'Сохранено в этом браузере' : 'Сохраняется автоматически'}</span><span id="note-length">${format(note.length)} / 10 000</span></div><div class="notice neutral"><div class="row">${icon('lock')}Локальное хранение</div>Заметки доступны только в этом браузере. Они сохраняются после обновления страницы, но не синхронизируются между устройствами.</div>`;
  }

  function empty() {
    return `<div class="inspector-head"><div class="inspector-top"><span class="eyebrow">Досье клиента</span><button class="icon-button close-inspector" data-action="close-inspector" aria-label="Закрыть досье">${icon('x')}</button></div><h2 class="client-role">Начните проверку</h2><div class="role-meta">Роль, переводы и основания — рядом со схемой.</div></div><div class="inspector-body"><div class="empty-state">${icon('file')}<strong>Клиент ещё не выбран</strong>Откройте клиента на схеме, в очереди или найдите его по полному GID.</div><button class="button primary" style="width:100%" data-action="root">${icon('arrowRight')}Первый в очереди</button><div class="notice neutral">В досье показаны наблюдаемые переводы и признаки для проверки. Решение остаётся за аналитиком.</div></div>`;
  }

  function community(ctx, cluster) {
    const members = (ctx.data.nodes || []).filter(node => String(node.cluster_id) === String(cluster.cluster_id));
    const counts = new Map();
    for (const node of members) counts.set(node.role, (counts.get(node.role) || 0) + 1);
    const roleRows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => {
      const description = ctx.data.roles && ctx.data.roles[key];
      const label = description && typeof description === 'object' ? description.label : typeof description === 'string' ? description : key;
      return `<div class="availability-row"><span>${escape(label)}</span><span class="pill">${format(count)}</span></div>`;
    }).join('');
    const priorities = (cluster.top_gids || []).filter(id => typeof id === 'string').map(id => lookup(ctx.byId, id) || members.find(node => node.gid === id)).filter(Boolean);
    const title = cluster.cluster_id === -1 ? 'Клиенты без связей' : `Сообщество ${cluster.cluster_id}`;
    return `<div class="inspector-head"><div class="inspector-top"><span class="eyebrow">Досье сообщества</span><button class="icon-button close-inspector" data-action="close-inspector" aria-label="Закрыть досье">${icon('x')}</button></div><h2 class="client-role">${escape(title)}</h2><div class="role-meta" style="flex-wrap:wrap"><span class="pill green">${format(cluster.n_nodes)} клиентов</span><span>${format(cluster.n_seed)} из исходного списка</span></div></div>
      <div class="inspector-body"><h3 class="inspector-section-title">Гипотеза структуры</h3><div class="observation">${icon('users')}<span>${escape(cluster.hypothesis || 'Текстовая гипотеза в выгрузке отсутствует.')}</span></div>
      <div class="divider"></div><h3 class="inspector-section-title">Наблюдаемый поток</h3><div class="observation">${icon('route')}<span>Между клиентами сообщества:<br><strong>${money(cluster.sum_kzt_internal)}</strong></span></div>
      ${flowRow(true, cluster.kzt_into_cluster, 'Из других сообществ выборки')}${flowRow(false, cluster.kzt_out_of_cluster, 'В другие сообщества выборки')}
      ${cluster.n_truncated > 0 ? `<div class="notice"><div class="row">${icon('warning')}Граница выгрузки</div>У ${format(cluster.n_truncated)} клиентов исходящие не исследованы: обход остановлен. Их конечная роль оценивается моделью, а не подтверждена наблюдением.</div>` : ''}
      <div class="divider"></div><h3 class="inspector-section-title">Предполагаемые роли</h3>${roleRows || '<p class="tiny muted">Нет данных о составе.</p>'}
      <div class="divider"></div><h3 class="inspector-section-title">Кого открыть первым</h3><p class="tiny muted" style="margin-bottom:10px">Приоритетные клиенты этого сообщества.</p>${priorities.map(node => {
        const role = ctx.data.roles && ctx.data.roles[node.role];
        return `<div class="inspector-transfer"><span class="direction-icon in">${icon('user')}</span><div class="transfer-info"><button class="text-button mono" data-gid="${escape(node.gid)}" title="Открыть досье клиента ${escape(node.gid)}">${escape(node.gid)}</button><small>${escape(role && typeof role === 'object' ? role.label : role || 'Роль не определена')}</small></div><strong class="transfer-amount" title="Индекс приоритета">${percent(node.priority_score)}%</strong></div>`;
      }).join('') || '<p class="tiny muted">Приоритетные клиенты не указаны.</p>'}</div>
      <div class="inspector-footer"><div class="footer-caution">${icon('info')}<span>Сообщество найдено по связям. Гипотеза структуры требует проверки аналитиком.</span></div></div>`;
  }

  function render(ctx) {
    if (!ctx || !ctx.data) return empty();
    if (typeof ctx.selected !== 'string') {
      const cluster = ctx.community != null && ctx.community !== '' ? (ctx.data.clusters || []).find(item => String(item.cluster_id) === String(ctx.community)) : null;
      return cluster ? community(ctx, cluster) : empty();
    }
    const node = lookup(ctx.byId, ctx.selected) || (ctx.data.nodes || []).find(item => item.gid === ctx.selected);
    if (!node || typeof node.gid !== 'string') return empty();
    const id = node.gid;
    const mark = lookup(ctx.marks, id);
    const status = Object.prototype.hasOwnProperty.call(STATUSES, mark) ? mark : 'none';
    const tab = ['overview', 'transfers', 'notes'].includes(ctx.tab) ? ctx.tab : 'overview';
    const role = ctx.data.roles && ctx.data.roles[node.role];
    const roleLabel = role && typeof role === 'object' ? role.label : typeof role === 'string' ? role : 'Роль не определена';
    const unknown = node.terminal_status === 'unknown_truncated';
    return `<div class="inspector-head"><div class="inspector-top"><span class="eyebrow">Досье клиента</span><div class="row"><span class="status-mini" id="client-status">${STATUSES[status]}</span><button class="icon-button close-inspector" data-action="close-inspector" aria-label="Закрыть досье">${icon('x')}</button></div></div><div class="inspector-gid"><strong>${escape(id)}</strong><button class="icon-button" data-action="copy-gid" aria-label="Скопировать полный GID" title="Скопировать GID">${icon('copy')}</button></div><h2 class="client-role">${escape(roleLabel)}</h2><div class="role-meta" style="flex-wrap:wrap"><span class="pill ${unknown ? 'amber' : 'green'}">${unknown ? 'Гипотеза · граница выгрузки' : 'Предполагаемая роль'}</span>${node.cluster_id != null ? `<span>Сообщество ${escape(node.cluster_id)}</span>` : ''}${node.is_seed ? '<span class="pill">Исходный клиент</span>' : ''}</div></div>
      <div class="inspector-tabs" role="tablist" aria-label="Разделы досье">${[['overview', 'Обзор'], ['transfers', 'Переводы'], ['notes', 'Заметки']].map(([key, label]) => `<button role="tab" aria-selected="${tab === key}" class="${tab === key ? 'active' : ''}" data-inspector-tab="${key}" id="tab-${key}" aria-controls="inspector-tab-panel">${label}${key === 'notes' && lookup(ctx.notes, id) ? ' ·' : ''}</button>`).join('')}</div>
      <div class="inspector-body" id="inspector-tab-panel" role="tabpanel" aria-labelledby="tab-${tab}">${tab === 'notes' ? notes(ctx, id) : tab === 'transfers' ? transfers(ctx, node) : overview(ctx, node)}</div>
      <div class="inspector-footer"><div class="footer-caution">${icon('info')}<span>Неполная выборка. Суммы не отражают полный баланс клиента.</span></div><div class="decision-buttons"><button class="button primary" data-action="mark-check" aria-pressed="${status === 'check'}">${icon(status === 'check' ? 'checkCircle' : 'check')}${status === 'check' ? 'В проверке' : 'Взять в проверку'}</button><button class="button defer ${status === 'later' ? 'amber' : ''}" data-action="mark-later" aria-pressed="${status === 'later'}" title="${status === 'later' ? 'Проверка отложена' : 'Отложить проверку'}" aria-label="Отложить проверку">${icon('clock')}</button></div>${status !== 'none' ? '<button class="text-button" data-action="clear-mark" style="display:block;margin:9px auto 0;font-size:10px">Снять личную отметку</button>' : ''}<p>Личная отметка в браузере. Не блокирует клиента.</p></div>`;
  }

  window.ApprovedInspector = Object.freeze({ render });
})();
