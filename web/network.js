/** A dependency-free, directed money-flow canvas. IDs are always opaque strings. */
export class MoneyNetwork {
  constructor(canvas, callbacks = {}) {
    if (!canvas || !canvas.getContext) throw new TypeError('MoneyNetwork requires a canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.adj = new Map();
    this.positions = new Map();
    this.visibleNodes = [];
    this.visibleEdges = [];
    this.removedIds = new Set();
    this.camera = { x: 0, y: 0, scale: 1 };
    this.target = { ...this.camera };
    this.view = { mode: 'focus', gid: null, clusterId: null };
    this.theme = 'light';
    this.width = 1;
    this.height = 1;
    this.fitScale = 1;
    this.pointers = new Map();
    this.hovered = null;
    this.frame = 0;
    this.destroyed = false;
    this.listeners = [];
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.cursor = 'grab';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Схема денежных переводов. Перетаскивайте для перемещения, прокручивайте для масштаба. Стрелки перемещают схему, плюс и минус меняют масштаб, ноль показывает всю схему.');
    this._listen(canvas, 'wheel', this._wheel.bind(this), { passive: false });
    this._listen(canvas, 'pointerdown', this._pointerDown.bind(this));
    this._listen(canvas, 'pointermove', this._pointerMove.bind(this));
    this._listen(canvas, 'pointerup', this._pointerUp.bind(this));
    this._listen(canvas, 'pointercancel', this._pointerCancel.bind(this));
    this._listen(canvas, 'pointerleave', () => { if (!this.pointers.size) this._hover(null); });
    this._listen(canvas, 'dblclick', this._doubleClick.bind(this));
    this._listen(canvas, 'keydown', this._keyDown.bind(this));
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this._resize();
  }

  setData(data) {
    this.data = data || {};
    // Never coerce numbers to strings here: a numeric 18-digit ID is already damaged.
    this.nodes = Array.isArray(data?.nodes) ? data.nodes.filter(n => n && typeof n.gid === 'string') : [];
    this.byId = new Map(this.nodes.map(n => [n.gid, n]));
    this.edges = Array.isArray(data?.edges) ? data.edges.filter(e => e && typeof e.src === 'string' && typeof e.dst === 'string' && this.byId.has(e.src) && this.byId.has(e.dst)) : [];
    this.adj = new Map(this.nodes.map(n => [n.gid, []]));
    for (const edge of this.edges) {
      this.adj.get(edge.src).push(edge);
      if (edge.dst !== edge.src) this.adj.get(edge.dst).push(edge);
    }
    this._layout();
    this.fit(false);
  }

  setView(next = {}) {
    const previous = this.view;
    const mode = ['focus', 'all', 'cluster'].includes(next.mode) ? next.mode : previous.mode;
    const gid = Object.hasOwn(next, 'gid') ? (typeof next.gid === 'string' ? next.gid : null) : previous.gid;
    const clusterId = Object.hasOwn(next, 'clusterId') ? next.clusterId : previous.clusterId;
    this.view = { mode, gid, clusterId };
    if (Object.hasOwn(next, 'removedIds')) this.removedIds = next.removedIds instanceof Set ? next.removedIds : new Set(next.removedIds || []);
    const changed = mode !== previous.mode || gid !== previous.gid || clusterId !== previous.clusterId;
    if (changed) {
      this._hover(null);
      this._layout();
      this.fit(false);
    } else {
      this._requestDraw();
    }
    this._notifyView();
  }

  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this._requestDraw();
  }

  fit(animate = true) {
    const all = [...this.positions.values()];
    if (!all.length) {
      this.target = { x: 0, y: 0, scale: 1 };
      this.camera = { ...this.target };
      this._requestDraw();
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of all) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const focus = this.view.mode === 'focus';
    const padX = focus ? 105 : 50, padY = focus ? 100 : 55;
    const fitScale = Math.min((this.width - Math.min(104, this.width * .22)) / Math.max(maxX - minX + padX * 2, 300), (this.height - 36) / Math.max(maxY - minY + padY * 2, 240));
    this.fitScale = Math.max(.025, Math.min(focus ? 1.32 : 1.6, fitScale));
    this.target = { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 + (focus ? 12 : 0), scale: this.fitScale };
    if (!animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) this.camera = { ...this.target };
    this._requestDraw();
    this._notifyView();
  }

  zoomBy(factor) {
    if (Number.isFinite(factor) && factor > 0) this._zoomAt(factor, this.width / 2, this.height / 2);
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    for (const [target, type, listener, options] of this.listeners) target.removeEventListener(type, listener, options);
    this.listeners = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.pointers.clear();
  }

  _listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.listeners.push([target, type, listener, options]);
  }

  _resize() {
    if (this.destroyed) return;
    const box = (this.canvas.parentElement || this.canvas).getBoundingClientRect();
    const width = Math.max(1, box.width), height = Math.max(1, box.height);
    if (width === this.width && height === this.height && this.dpr === Math.min(window.devicePixelRatio || 1, 2)) return;
    const wasHidden = this.width < 10 || this.height < 10;
    const oldWidth = this.width;
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    if (wasHidden || Math.abs(width - oldWidth) > 100) this.fit(false);
    else this._requestDraw();
  }

  _layout() {
    this.positions = new Map();
    this.focusMeta = null;
    this.highlightIds = new Set();
    const selected = this.byId.get(this.view.gid);
    if (selected) {
      this.highlightIds.add(selected.gid);
      for (const e of this.adj.get(selected.gid) || []) {
        this.highlightIds.add(e.src);
        this.highlightIds.add(e.dst);
      }
    }
    if (this.view.mode === 'focus') {
      if (!selected) { this.visibleNodes = []; this.visibleEdges = []; return; }
      const related = this.adj.get(selected.gid) || [];
      const neighbors = new Map();
      for (const e of related) {
        const id = e.src === selected.gid ? e.dst : e.src;
        if (id === selected.gid) continue;
        if (!neighbors.has(id)) neighbors.set(id, { node: this.byId.get(id), incoming: 0, outgoing: 0 });
        const n = neighbors.get(id);
        if (e.dst === selected.gid) n.incoming += Math.max(0, Number(e.sum_kzt) || 0);
        if (e.src === selected.gid) n.outgoing += Math.max(0, Number(e.sum_kzt) || 0);
      }
      const byAmount = (a, b) => (b.incoming + b.outgoing) - (a.incoming + a.outgoing);
      const incoming = [...neighbors.values()].filter(n => n.incoming >= n.outgoing).sort(byAmount);
      const outgoing = [...neighbors.values()].filter(n => n.incoming < n.outgoing).sort(byAmount);
      this.positions.set(selected.gid, { x: 0, y: 0, selected: true, amount: null });
      const place = (list, side) => {
        // Every neighbor remains present; large fans gain columns instead of vanishing into a "+N" placeholder.
        const columns = Math.max(1, Math.ceil(list.length / 11));
        const rows = Math.ceil(list.length / columns);
        list.forEach((item, i) => {
          const col = Math.floor(i / rows), row = i % rows;
          const count = Math.min(rows, list.length - col * rows);
          this.positions.set(item.node.gid, { x: side * (310 + col * 235), y: (row - (count - 1) / 2) * 88, amount: item.incoming + item.outgoing, incoming: item.incoming, outgoing: item.outgoing, side });
        });
      };
      place(incoming, -1); place(outgoing, 1);
      const ys = [...this.positions.values()].map(p => p.y);
      this.focusMeta = { incoming: incoming.length, outgoing: outgoing.length, top: Math.min(...ys) - 70 };
      this.visibleNodes = [selected, ...neighbors.values()].map(n => n.node || n);
      this.visibleEdges = related;
      return;
    }
    this.visibleNodes = this.view.mode === 'cluster' ? this.nodes.filter(n => n.cluster_id === this.view.clusterId) : this.nodes;
    const visible = new Set(this.visibleNodes.map(n => n.gid));
    this.visibleEdges = this.edges.filter(e => visible.has(e.src) && visible.has(e.dst));
    this.visibleNodes.forEach((node, index) => {
      // The export owns the overview layout. A deterministic fallback handles incomplete exports.
      const angle = index * 2.399963229728653;
      const radius = Math.sqrt(index / Math.max(1, this.visibleNodes.length)) * 520;
      this.positions.set(node.gid, {
        x: Number.isFinite(node.x) ? (node.x - .5) * 1500 : Math.cos(angle) * radius,
        y: Number.isFinite(node.y) ? (node.y - .5) * 1500 : Math.sin(angle) * radius,
      });
    });
  }

  _palette() {
    return this.theme === 'dark' ? {
      text: '#e9efe5', muted: '#a5b39e', quiet: '#72836e', line: '#93aa88', strong: '#a4d07d', fill: '#82a66d', weak: '#53694a', selected: '#b8ed83', selectedText: '#20301b', halo: '#99ce68', seed: '#c2d9ad', paper: '#142018', boundary: '#c9b773', removed: '#748176',
    } : {
      text: '#213227', muted: '#60715d', quiet: '#91a18a', line: '#6f8d61', strong: '#477a31', fill: '#91ae7c', weak: '#c0cfb5', selected: '#347a2f', selectedText: '#ffffff', halo: '#8dc264', seed: '#436a35', paper: '#fafcf7', boundary: '#9b813c', removed: '#a5afa1',
    };
  }

  _requestDraw() {
    if (!this.frame && !this.destroyed) this.frame = requestAnimationFrame(() => this._drawFrame());
  }

  _drawFrame() {
    this.frame = 0;
    if (this.destroyed) return;
    let moving = false;
    for (const key of ['x', 'y', 'scale']) {
      const delta = this.target[key] - this.camera[key];
      const epsilon = key === 'scale' ? .00005 : .02;
      if (Math.abs(delta) > epsilon) { this.camera[key] += delta * .27; moving = true; }
      else this.camera[key] = this.target[key];
    }
    this._draw();
    if (moving) this._requestDraw();
  }

  _point(id) {
    const p = this.positions.get(id);
    if (!p) return null;
    return { x: this.width / 2 + (p.x + this.camera.x) * this.camera.scale, y: this.height / 2 + (p.y + this.camera.y) * this.camera.scale };
  }

  _radius(node) {
    const focus = this.view.mode === 'focus';
    if (node.gid === this.view.gid) return focus ? Math.max(13, Math.min(28, 23 * this.camera.scale)) : Math.max(5.5, Math.min(16, 7 * this.camera.scale));
    if (focus) return Math.max(4, Math.min(17, (node.is_seed ? 11 : 9) * this.camera.scale));
    return Math.max(1.5, Math.min(12, (2.3 + (Number(node.priority_score) || 0) * 2.5 + (node.is_seed ? .9 : 0)) * this.camera.scale));
  }

  _draw() {
    const ctx = this.ctx, p = this._palette();
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.visibleNodes.length) {
      ctx.fillStyle = p.muted;
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this.nodes.length ? 'Выберите клиента, чтобы проследить переводы' : 'Схема появится после загрузки данных', this.width / 2, this.height / 2);
      return;
    }
    if (this.focusMeta) this._drawLanes(ctx, p);
    const selected = this.view.gid;
    const focus = this.view.mode === 'focus';
    // Quiet background first; selected relationships remain legible above it.
    if (!focus && selected) {
      for (const edge of this.visibleEdges) if (edge.src !== selected && edge.dst !== selected) this._drawEdge(ctx, edge, p, false);
      for (const edge of this.visibleEdges) if (edge.src === selected || edge.dst === selected) this._drawEdge(ctx, edge, p, true);
    } else {
      for (const edge of this.visibleEdges) this._drawEdge(ctx, edge, p, focus);
    }
    for (const node of this.visibleNodes) if (node.gid !== selected && node.gid !== this.hovered?.gid) this._drawNode(ctx, node, p);
    if (this.hovered && this.positions.has(this.hovered.gid) && this.hovered.gid !== selected) this._drawNode(ctx, this.hovered, p);
    if (selected && this.positions.has(selected)) this._drawNode(ctx, this.byId.get(selected), p);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  _drawLanes(ctx, p) {
    if (this.camera.scale < .35) return;
    const top = this.height / 2 + (this.focusMeta.top + this.camera.y) * this.camera.scale;
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = p.muted;
    const labels = [[-310, 'ПОСТУПЛЕНИЯ'], [310, 'ПЕРЕВОДЫ ДАЛЬШЕ']];
    for (const [x, label] of labels) {
      const sx = this.width / 2 + (x + this.camera.x) * this.camera.scale;
      ctx.fillText(label, sx, top);
    }
  }

  _drawEdge(ctx, edge, p, active) {
    const source = this._point(edge.src), destination = this._point(edge.dst);
    if (!source || !destination) return;
    const focus = this.view.mode === 'focus';
    const removed = this.removedIds.has(edge.src) || this.removedIds.has(edge.dst);
    const opacity = removed ? .045 : focus ? .43 : active ? .62 : this.view.gid ? .055 : this.theme === 'dark' ? .10 : .12;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = active ? p.strong : p.line;
    ctx.lineWidth = focus ? Math.min(3.6, .8 + Math.log10(1 + Math.max(0, Number(edge.sum_kzt) || 0)) * .30) : active ? 1.3 : .55;
    if (removed && focus) ctx.setLineDash([3, 5]);
    let tip, tangent;
    if (edge.src === edge.dst) {
      const radius = this._radius(this.byId.get(edge.src));
      ctx.beginPath();
      ctx.arc(source.x, source.y - radius * 1.2, radius * 1.6, .35, Math.PI * 2 - .35);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (focus) {
      const srcRadius = this._radius(this.byId.get(edge.src)) + 3;
      const dstRadius = this._radius(this.byId.get(edge.dst)) + 4;
      const sign = destination.x >= source.x ? 1 : -1;
      const start = { x: source.x + sign * srcRadius, y: source.y };
      const end = { x: destination.x - sign * dstRadius, y: destination.y };
      const dx = end.x - start.x;
      const bend = edge.src === this.view.gid && destination.x < source.x ? 9 : 0;
      const c1 = { x: start.x + dx * .55, y: start.y + bend };
      const c2 = { x: end.x - dx * .55, y: end.y + bend };
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
      ctx.stroke();
      tip = end; tangent = { x: end.x - c2.x, y: end.y - c2.y };
    } else {
      const dx = destination.x - source.x, dy = destination.y - source.y;
      const length = Math.hypot(dx, dy) || 1;
      const radius = this._radius(this.byId.get(edge.dst)) + 2;
      tip = { x: destination.x - dx / length * radius, y: destination.y - dy / length * radius };
      tangent = { x: dx, y: dy };
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!removed && (focus || active || this.camera.scale > 2.3)) {
      const angle = Math.atan2(tangent.y, tangent.x);
      const size = focus ? 5 : 3.5;
      ctx.globalAlpha = focus ? .74 : active ? .75 : .18;
      ctx.fillStyle = active ? p.strong : p.line;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - Math.cos(angle - .48) * size, tip.y - Math.sin(angle - .48) * size);
      ctx.lineTo(tip.x - Math.cos(angle + .48) * size, tip.y - Math.sin(angle + .48) * size);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawNode(ctx, node, p) {
    if (!node) return;
    const position = this._point(node.gid);
    if (!position || position.x < -160 || position.x > this.width + 160 || position.y < -100 || position.y > this.height + 100) return;
    const { x, y } = position;
    const selected = node.gid === this.view.gid;
    const hovered = node.gid === this.hovered?.gid;
    const focus = this.view.mode === 'focus';
    const removed = this.removedIds.has(node.gid);
    const radius = this._radius(node);
    const muted = !focus && this.view.gid && !this.highlightIds.has(node.gid) && !hovered;
    ctx.globalAlpha = removed ? .24 : muted ? .38 : 1;
    if (selected || hovered) {
      ctx.beginPath(); ctx.arc(x, y, radius + (selected ? 7 : 5), 0, Math.PI * 2);
      ctx.fillStyle = p.halo; ctx.globalAlpha = removed ? .05 : .13; ctx.fill();
      ctx.globalAlpha = removed ? .24 : 1;
    }
    ctx.fillStyle = selected ? p.selected : node.is_seed ? p.paper : node.role === 'coordinator' || node.role === 'consolidator' ? p.strong : focus ? p.fill : p.weak;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    if (node.is_seed || hovered || selected) {
      ctx.strokeStyle = selected ? p.selected : p.seed;
      ctx.lineWidth = node.is_seed ? 1.6 : 1.2;
      ctx.stroke();
    }
    if (node.is_seed && radius > 3) {
      ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, radius - 3.5), 0, Math.PI * 2);
      ctx.fillStyle = selected ? p.selectedText : p.seed; ctx.fill();
    }
    if (node.truncated_by_depth && radius > 2.3) {
      ctx.beginPath(); ctx.arc(x, y, radius + 3.8, 0, Math.PI * 2);
      ctx.strokeStyle = p.boundary; ctx.lineWidth = 1.15; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (removed) {
      ctx.globalAlpha = .55;
      ctx.strokeStyle = p.removed;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x - radius - 2, y - radius - 2); ctx.lineTo(x + radius + 2, y + radius + 2); ctx.stroke();
    }
    if (selected && focus && radius > 16) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = p.selectedText; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(x, y - 5, 3.6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y + 7, 7, Math.PI, Math.PI * 2); ctx.stroke();
    }
    const labelVisible = selected || hovered || (focus && this.camera.scale >= .32) || (!focus && this.camera.scale > 2.7 && Number(node.priority_score) > .55);
    if (labelVisible) {
      const fontSize = focus ? this.camera.scale < .55 ? 10 : 12 : 11;
      const label = `…${node.gid.slice(-9)}`;
      const labelY = y + radius + (selected ? 22 : 17);
      ctx.globalAlpha = removed ? .4 : 1;
      ctx.font = `${selected ? 600 : 500} ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
      ctx.textAlign = 'center';
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = p.paper;
      ctx.globalAlpha = removed ? .4 : .92;
      ctx.fillRect(x - textWidth / 2 - 4, labelY - fontSize, textWidth + 8, fontSize + 4);
      ctx.globalAlpha = removed ? .4 : 1;
      ctx.fillStyle = p.text;
      ctx.fillText(label, x, labelY);
      const info = this.positions.get(node.gid);
      if (focus && !selected && info.amount != null && this.camera.scale >= .45) {
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = p.muted;
        ctx.fillText(this._money(info.amount), x, labelY + 15);
      } else if (selected && focus) {
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = p.muted;
        ctx.fillText(node.is_seed ? 'из исходного списка' : 'клиент в фокусе', x, labelY + 17);
      }
    }
    ctx.globalAlpha = 1;
  }

  _money(value) {
    const n = Number(value) || 0;
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: n >= 1e6 ? 1 : 0 }).format(n >= 1e6 ? n / 1e6 : n >= 1e3 ? n / 1e3 : n)} ${n >= 1e6 ? 'млн' : n >= 1e3 ? 'тыс.' : ''} ₸`;
  }

  _local(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  _hit(x, y) {
    let best = null, bestDistance = Infinity;
    for (const node of this.visibleNodes) {
      const point = this._point(node.gid);
      const distance = Math.hypot(point.x - x, point.y - y);
      const limit = Math.max(this.view.mode === 'focus' ? 16 : 9, this._radius(node) + 5);
      if (distance < limit && distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best;
  }

  _hover(node) {
    if (node?.gid === this.hovered?.gid) return;
    this.hovered = node;
    this.canvas.style.cursor = this.pointers.size ? 'grabbing' : node ? 'pointer' : 'grab';
    this.canvas.title = node ? `${node.gid} · ${this.data.roles?.[node.role]?.label || node.role || 'Клиент'}` : '';
    this.callbacks.onHover?.(node);
    this._requestDraw();
  }

  _wheel(event) {
    event.preventDefault();
    const point = this._local(event);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
    this._zoomAt(Math.exp(-Math.max(-160, Math.min(160, delta)) * .0024), point.x, point.y);
  }

  _zoomAt(factor, x, y) {
    const before = this.target.scale;
    const after = Math.min(Math.max(4, this.fitScale * 24), Math.max(this.fitScale * .24, before * factor));
    if (Math.abs(after - before) < .000001) return;
    const wx = (x - this.width / 2) / before - this.target.x;
    const wy = (y - this.height / 2) / before - this.target.y;
    this.target = { scale: after, x: (x - this.width / 2) / after - wx, y: (y - this.height / 2) / after - wy };
    this._requestDraw();
    this._notifyView();
  }

  _pointerDown(event) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = this._local(event);
    this.pointers.set(event.pointerId, point);
    this.camera = { ...this.target };
    this.drag = { x: point.x, y: point.y, distance: 0, started: performance.now(), pinched: this.pointers.size > 1 };
    this.canvas.style.cursor = 'grabbing';
    this._hover(null);
    this._requestDraw();
  }

  _pointerMove(event) {
    const point = this._local(event);
    if (!this.pointers.has(event.pointerId)) { if (!this.pointers.size) this._hover(this._hit(point.x, point.y)); return; }
    const previous = this.pointers.get(event.pointerId);
    if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
        const newDistance = Math.hypot(point.x - other.x, point.y - other.y);
        const beforeCenter = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        const afterCenter = { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 };
        this._zoomAt(oldDistance > 2 ? newDistance / oldDistance : 1, beforeCenter.x, beforeCenter.y);
        this.target.x += (afterCenter.x - beforeCenter.x) / this.target.scale;
        this.target.y += (afterCenter.y - beforeCenter.y) / this.target.scale;
        this.drag.pinched = true;
      }
    } else {
      const dx = point.x - previous.x, dy = point.y - previous.y;
      this.target.x += dx / this.target.scale;
      this.target.y += dy / this.target.scale;
      if (this.drag) this.drag.distance += Math.hypot(dx, dy);
    }
    this.pointers.set(event.pointerId, point);
    this.camera = { ...this.target };
    this._requestDraw();
  }

  _pointerUp(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const point = this._local(event);
    const clicked = this.pointers.size === 1 && this.drag && this.drag.distance < 7 && !this.drag.pinched;
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (clicked) {
      const node = this._hit(point.x, point.y);
      if (node) this.callbacks.onSelect?.(node.gid);
    }
    if (!this.pointers.size) { this.drag = null; this._hover(this._hit(point.x, point.y)); this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab'; }
    this._notifyView();
  }

  _pointerCancel(event) {
    this.pointers.delete(event.pointerId);
    if (!this.pointers.size) { this.drag = null; this.canvas.style.cursor = 'grab'; }
  }

  _doubleClick(event) {
    event.preventDefault();
    const point = this._local(event), node = this._hit(point.x, point.y);
    if (node) {
      this.callbacks.onSelect?.(node.gid);
      if (this.view.mode !== 'focus') this.setView({ mode: 'focus', gid: node.gid });
      else this.fit();
    } else this.fit();
  }

  _keyDown(event) {
    const actions = {
      '+': () => this.zoomBy(1.3), '=': () => this.zoomBy(1.3), '-': () => this.zoomBy(1 / 1.3), '0': () => this.fit(), Home: () => this.fit(),
      ArrowLeft: () => { this.target.x += 65 / this.target.scale; }, ArrowRight: () => { this.target.x -= 65 / this.target.scale; },
      ArrowUp: () => { this.target.y += 65 / this.target.scale; }, ArrowDown: () => { this.target.y -= 65 / this.target.scale; },
      Escape: () => this.fit(),
    };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); this._requestDraw(); this._notifyView(); }
  }

  _notifyView() {
    this.callbacks.onViewChange?.({ ...this.view, zoom: this.target.scale / this.fitScale, scale: this.target.scale });
  }
}
