import { NU, THETA, SAFE_FLOOR, PART_FLOOR, BETA } from '../engine/constants';
import { binaryEntropy, boltzmann, coherence } from '../engine/kernels';
import { referenceGraph, REFERENCE_SEEDS, REFERENCE_CREATORS, REFERENCE_EPOCH } from '../engine/fixtures';
import type { EdgeRecord } from '../engine/graph';
import { rankFeed } from '../engine/feed';
import { solveStanding, evaluateGates, refRate, type Ledger, type FoldCell } from '../engine/standing';
import { FAMILIES } from '../engine/families';

// ── State ──────────────────────────────────────────────────────────────

const graph = referenceGraph();
const ledgers: Ledger[] = REFERENCE_SEEDS.map((l) => ({ ...l }));
const deltaActs = new Map<string, number>();
const vouchBundles = new Map<string, { src: string; rcp: string; pd: number; pi: number }>();
const actLog: string[] = [];
let selectedEdgeId: string | null = null;
let viewerId = 'bob';
let authoredCount = 0;

const PROFILE_ACTOR: Record<string, string> = { profA: 'alice' };

const NODE_POS: Record<string, [number, number]> = {
  alice: [140, 120],
  profA: [55, 245],
  photo: [350, 70],
  bob: [560, 110],
  comment: [350, 240],
  carol: [610, 300],
  streetart: [170, 375],
  sneakers: [690, 195],
  dave: [690, 420],
};

function clip(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function currentCells(): FoldCell[] {
  const cells: FoldCell[] = [];
  for (const b of vouchBundles.values()) {
    const pd = clip(b.pd);
    const pi = clip(b.pi);
    if (pd > 0 && pi > 0) cells.push({ src: b.src, rcp: b.rcp, coeff: Math.sqrt(pd * pi) });
  }
  return cells;
}

interface Solved {
  ids: string[];
  x: number[];
  iterations: number;
  standingOf: (id: string) => number;
}

function solveGraphStanding(): Solved {
  const result = solveStanding(ledgers, currentCells(), { tilt: 1 });
  const idx = new Map(result.ids.map((id, i) => [id, i]));
  return {
    ids: result.ids,
    x: result.x,
    iterations: result.iterations,
    standingOf: (id) => {
      const i = idx.get(id);
      return i === undefined ? 0 : NU * result.x[i]!;
    },
  };
}

// ── DOM helpers ────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svgEl(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function fmt(v: number, digits = 3): string {
  return v.toFixed(digits);
}

function heatColor(v: number): string {
  // −1 → red, 0 → slate, +1 → green, on dark background
  const t = Math.max(-1, Math.min(1, v));
  if (t >= 0) {
    const g = Math.round(140 + 90 * t);
    return `rgb(${Math.round(126 - 60 * t)}, ${g}, ${Math.round(135 - 30 * t)})`;
  }
  const r = Math.round(150 + 90 * -t);
  return `rgb(${r}, ${Math.round(120 + 40 * t)}, ${Math.round(115 + 30 * t)})`;
}

function matrixView(m: number[][], title: string): HTMLElement {
  const cols = m[0]?.length ?? 0;
  const grid = el('div', { class: 'mat', style: `grid-template-columns: repeat(${cols}, auto)` });
  for (const row of m) {
    for (const v of row) {
      grid.append(
        el('div', { class: 'cell', style: `background:${heatColor(v)}` }, v === 0 ? '0' : fmt(v, 2)),
      );
    }
  }
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'mat-title' }, title), grid);
  return wrap;
}

function bar(label: string, value: number, max: number, valueText?: string): HTMLElement {
  const pct = max > 0 ? Math.max(2, (100 * value) / max) : 0;
  return el(
    'div',
    { class: 'bar-row' },
    el('div', { class: 'bar-label' }, label),
    el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `width:${pct}%` })),
    el('div', { class: 'bar-value' }, valueText ?? fmt(value)),
  );
}

// ── Graph canvas ───────────────────────────────────────────────────────

function edgeColor(e: EdgeRecord): string {
  if (e.sign < 0) return '#f85149';
  if (e.tier === 'half') return '#d29922';
  if (e.tier === 'marginal') return '#8b949e';
  return '#58a6ff';
}

function renderGraph(): void {
  const svg = document.getElementById('graph')!;
  svg.innerHTML = '';

  const defs = svgEl('defs');
  for (const [id, color] of [
    ['arrow-blue', '#58a6ff'],
    ['arrow-red', '#f85149'],
    ['arrow-gold', '#d29922'],
    ['arrow-grey', '#8b949e'],
  ] as const) {
    const marker = svgEl('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.append(marker);
  }
  svg.append(defs);

  // multi-edge offset bookkeeping per unordered node pair
  const pairSeen = new Map<string, number>();

  for (const e of graph.edges) {
    const p1 = NODE_POS[e.src];
    const p2 = NODE_POS[e.tgt];
    if (!p1 || !p2) continue;
    const pairKey = [e.src, e.tgt].sort().join('|');
    const n = pairSeen.get(pairKey) ?? 0;
    pairSeen.set(pairKey, n + 1);

    const [x1, y1] = p1;
    const [x2, y2] = p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // shrink to node boundary
    const pad = 26;
    const sx = x1 + (dx / len) * pad;
    const sy = y1 + (dy / len) * pad;
    const tx = x2 - (dx / len) * pad;
    const ty = y2 - (dy / len) * pad;
    // perpendicular offset for parallel edges (direction-aware for 2-cycles)
    const dir = e.src < e.tgt ? 1 : -1;
    const off = n === 0 && !graph.edges.some((o) => o !== e && o.src === e.tgt && o.tgt === e.src)
      ? 0
      : 14 * dir * (n === 0 ? 1 : 1 + 0.6 * n);
    const mx = (sx + tx) / 2 + (-dy / len) * off;
    const my = (sy + ty) / 2 + (dx / len) * off;

    const color = edgeColor(e);
    const markerId =
      e.sign < 0 ? 'arrow-red' : e.tier === 'half' ? 'arrow-gold' : e.tier === 'marginal' ? 'arrow-grey' : 'arrow-blue';
    const g = svgEl('g', { class: `edge${selectedEdgeId === e.id ? ' selected' : ''}` });
    const width = 1 + e.weight * 9;
    const path = svgEl('path', {
      class: 'line',
      d: `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`,
      stroke: color,
      'stroke-width': String(width),
      'stroke-opacity': selectedEdgeId === e.id ? '1' : '0.75',
      'marker-end': `url(#${markerId})`,
    });
    // fat invisible hit area
    const hit = svgEl('path', {
      d: `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`,
      stroke: 'transparent',
      'stroke-width': '14',
    });
    const label = svgEl('text', { x: String(mx), y: String(my - 5) });
    label.textContent = `${e.id} · ${fmt(e.weight)}`;
    g.append(hit, path, label);
    g.addEventListener('click', () => {
      selectedEdgeId = e.id;
      renderGraph();
      renderInspector();
    });
    svg.append(g);
  }

  for (const node of graph.nodes.values()) {
    const pos = NODE_POS[node.id];
    if (!pos) continue;
    const [x, y] = pos;
    const g = svgEl('g', { class: 'node' });
    if (node.kind === 'Actor') {
      g.append(svgEl('circle', { cx: String(x), cy: String(y), r: '22', fill: 'rgba(88,166,255,0.18)', stroke: '#58a6ff' }));
    } else if (node.kind === 'Profile') {
      g.append(
        svgEl('polygon', {
          points: `${x},${y - 24} ${x + 24},${y} ${x},${y + 24} ${x - 24},${y}`,
          fill: 'rgba(188,140,255,0.15)',
          stroke: '#bc8cff',
        }),
      );
    } else {
      g.append(
        svgEl('rect', {
          x: String(x - 26),
          y: String(y - 18),
          width: '52',
          height: '36',
          rx: '8',
          fill: 'rgba(126,231,135,0.12)',
          stroke: '#7ee787',
        }),
      );
    }
    const name = svgEl('text', { x: String(x), y: String(y + 3) });
    name.textContent = node.label;
    const kind = svgEl('text', { x: String(x), y: String(y + 15), class: 'kind' });
    kind.textContent = node.kind;
    g.append(name, kind);
    svg.append(g);
  }
}

// ── Inspector ──────────────────────────────────────────────────────────

function renderInspector(): void {
  const host = document.getElementById('inspector')!;
  host.innerHTML = '';
  const e = graph.edges.find((x) => x.id === selectedEdgeId);
  if (!e) {
    host.append(el('p', { class: 'hint' }, 'Select an edge in the graph.'));
    return;
  }
  const spec = FAMILIES[e.family];
  const srcLabel = graph.nodes.get(e.src)?.label ?? e.src;
  const tgtLabel = graph.nodes.get(e.tgt)?.label ?? e.tgt;

  host.append(
    el('div', { class: 'kv' },
      el('b', {}, `${e.id}: ${srcLabel} → ${tgtLabel}`),
      el('span', {}, `${e.family} · ${e.domain} · tier ${e.tier}`),
    ),
    el('div', { class: 'kv' },
      el('span', {}, `${spec?.paramLabels[0] ?? 'p_d'} = `), el('b', {}, fmt(e.pd, 2)),
      el('span', {}, `${spec?.paramLabels[1] ?? 'p_i'} = `), el('b', {}, fmt(e.pi, 2)),
      el('span', {}, 'τ = '), el('b', {}, fmt(e.tau, 3)),
      el('span', {}, 'sign'), el('b', {}, e.sign > 0 ? '+1' : '−1'),
    ),
  );

  const H = binaryEntropy(e.tau);
  const chain = el('div', { class: 'chain' });
  const term = (v: string, s: string) => el('div', { class: 'term' }, v, el('small', {}, s));
  chain.append(
    term(fmt(e.score), 'det score √|det PV|'),
    el('span', { class: 'op' }, '×'),
    term(fmt(coherence(e.tau)), '√(1+τ²) coherence'),
    el('span', { class: 'op' }, '×'),
    term(fmt(boltzmann(e.tau)), `e^(−β·H), H=${fmt(H)}`),
    el('span', { class: 'op' }, '='),
    (() => {
      const t = term(fmt(e.weight), 'damped weight');
      t.classList.add('result');
      return t;
    })(),
  );
  host.append(chain);

  const mats = el('div', { style: 'display:flex; flex-wrap:wrap' });
  mats.append(matrixView(e.slice, `stored Ψ 3×3 · ‖Ψ‖F = ${fmt(e.frob)}`));
  mats.append(matrixView(e.pv, `path view 2×2 · det = ${fmt(e.pv[0]![0]! * e.pv[1]![1]! - e.pv[0]![1]! * e.pv[1]![0]!, 4)}`));
  host.append(mats);
  host.append(
    el('p', { class: 'note' },
      `β = ${fmt(BETA)} · mask [${e.mask.join(', ')}] on the bilinear block only — marginals and the 0.8 baseline are always live.`),
  );
}

// ── Feed ───────────────────────────────────────────────────────────────

function renderFeed(solved: Solved): void {
  const host = document.getElementById('feed')!;
  host.innerHTML = '';
  const feed = rankFeed(graph, viewerId, solved.standingOf, (id) => REFERENCE_CREATORS[id] ?? null);
  const ranked = feed.filter((f) => f.relevance > 0);
  const silent = feed.filter((f) => f.relevance <= 0);
  if (feed.length === 0) {
    host.append(el('p', { class: 'hint' }, 'Nothing reachable within depth 4.'));
    return;
  }
  const max = ranked[0]?.relevance ?? 1;
  for (const f of ranked) {
    host.append(bar(f.node.label, f.relevance, max));
    host.append(
      el('p', { class: 'note', style: 'margin:0 0 6px 86px' },
        `W=${fmt(f.bfsWeight)} · amp=${fmt(f.amplifier, 2)} · ‖T‖F=${fmt(f.contentNorm)}`),
    );
  }
  if (silent.length > 0) {
    host.append(
      el('p', { class: 'note' },
        `${silent.length} reachable artifact${silent.length === 1 ? '' : 's'} (${silent
          .map((f) => f.node.label)
          .join(', ')}) carr${silent.length === 1 ? 'ies' : 'y'} no Opinion stance tensor yet — author one to give them a feed presence.`),
    );
  }
  host.append(
    el('p', { class: 'note' },
      'S(viewer, c) = W_BFS · (1 + standing(creator)/ν) · ‖T_c‖F — double-cover positive register, depth 4.'),
  );
}

// ── Standing (4 sandbox actors) ────────────────────────────────────────

function renderStanding(solved: Solved): void {
  const host = document.getElementById('standing')!;
  host.innerHTML = '';
  const cells = currentCells();

  const table = el('table', {});
  table.append(
    el('tr', {},
      el('th', {}, 'actor'), el('th', { class: 'num' }, 'burn'), el('th', { class: 'num' }, 'N'),
      el('th', { class: 'num' }, 'rate'), el('th', { class: 'num' }, 'x* (reduced)'),
      el('th', { class: 'num' }, 'standing'), el('th', {}, 'W2a'),
    ),
  );
  ledgers.forEach((l, i) => {
    const x = solved.x[i]!;
    const pass = x >= SAFE_FLOOR;
    table.append(
      el('tr', {},
        el('td', {}, graph.nodes.get(l.id)?.label ?? l.id),
        el('td', { class: 'num' }, fmt(l.burnBal, 3)),
        el('td', { class: 'num' }, String(l.actCount)),
        el('td', { class: 'num' }, fmt(l.burnBal / Math.max(l.actCount, 1), 3)),
        el('td', { class: 'num' }, fmt(x, 4)),
        el('td', { class: 'num' }, fmt(NU * x, 4)),
        el('td', {}, el('span', { class: `gate ${pass ? 'pass' : 'fail'}` }, pass ? '≥ wall' : 'below wall')),
      ),
    );
  });
  host.append(table);

  const gates = evaluateGates(ledgers, solved.x, deltaActs);
  const gateRow = el('div', { style: 'margin-top:8px' });
  gateRow.append(
    el('span', { class: `gate ${gates.w1.every((g) => g.pass) ? 'pass' : 'fail'}` }, 'W1 solvency'),
    el('span', { class: `gate ${gates.w2a.every((g) => g.pass) ? 'pass' : 'fail'}` }, 'W2a wall'),
    el('span', { class: `gate ${gates.w2bPass ? 'pass' : 'fail'}` },
      `W2b door · stamp ${deltaActs.size ? fmt(gates.epochStamp, 3) : '—'} vs ${PART_FLOOR}`),
  );
  host.append(gateRow);
  host.append(
    el('p', { class: 'note' },
      `${cells.length} person-vouch cell${cells.length === 1 ? '' : 's'} compiled · solve ${solved.iterations} passes · ` +
      `safefloor ${fmt(SAFE_FLOOR, 4)} · θ ${fmt(THETA, 4)}/act. ` +
      (cells.length === 0
        ? 'No vouch paths yet — every standing equals its own commitment rate. Author a positive Opinion on Profile_A to move mass.'
        : 'Standings now mediate transported (balance, count) pairs.')),
  );
}

// ── Reference epoch panel ──────────────────────────────────────────────

function renderEpoch(): void {
  const host = document.getElementById('epoch')!;
  host.innerHTML = '';
  const res = solveStanding(REFERENCE_EPOCH.ledgers, REFERENCE_EPOCH.cells, { tilt: 1 });
  const gates = evaluateGates(REFERENCE_EPOCH.ledgers, res.x, REFERENCE_EPOCH.deltaActs);

  const max = Math.max(...res.x);
  res.ids.forEach((id, i) => {
    const expected = REFERENCE_EPOCH.expectedX[i]!;
    const match = Math.abs(res.x[i]! - expected) < 1e-4;
    host.append(
      bar(id[0]!.toUpperCase() + id.slice(1), res.x[i]!, max, `${fmt(res.x[i]!, 5)} ${match ? '✓' : '✗'}`),
    );
  });
  host.append(
    el('div', { class: 'kv' },
      el('span', {}, 'epoch stamp'), el('b', {}, `${fmt(gates.epochStamp, 3)} (spec 1.102)`),
      el('span', {}, 'headroom'), el('b', {}, `${fmt(gates.headroom, 3)} (spec 0.615)`),
      el('span', {}, 'passes'), el('b', {}, String(res.iterations)),
    ),
    el('p', { class: 'note' },
      '✓ = matches the certified equilibrium to 1e-4. Fold coefficients, ledger, and Δ-acts are the Appendix F fixture; solve runs at full tilt strength with wall-clamped activation.'),
  );
}

// ── Author form ────────────────────────────────────────────────────────

const AUTHORABLE = ['Opinion', 'Affinity'] as const;

function renderAuthor(): void {
  const host = document.getElementById('author')!;
  host.innerHTML = '';

  const authorSel = el('select', { id: 'author-actor' });
  for (const l of ledgers) {
    authorSel.append(el('option', { value: l.id }, graph.nodes.get(l.id)?.label ?? l.id));
  }
  const familySel = el('select', { id: 'author-family' });
  for (const f of AUTHORABLE) familySel.append(el('option', { value: f }, f));

  const targetSel = el('select', { id: 'author-target' });
  const refreshTargets = () => {
    targetSel.innerHTML = '';
    const family = familySel.value;
    for (const n of graph.nodes.values()) {
      if (n.kind === 'Actor') continue;
      if (family === 'Affinity' && n.kind !== 'Type') continue;
      targetSel.append(el('option', { value: n.id }, `${n.label} (${n.kind})`));
    }
  };
  refreshTargets();
  familySel.addEventListener('change', refreshTargets);

  const mkSlider = (id: string, label: string) => {
    const input = el('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: '0.7', id });
    const out = el('output', {}, '0.70');
    input.addEventListener('input', () => (out.textContent = Number(input.value).toFixed(2)));
    return { row: el('div', { class: 'slider-row' }, input, out), input, label };
  };
  const s1 = mkSlider('author-pd', 'p_d');
  const s2 = mkSlider('author-pi', 'p_i');

  const btn = el('button', { class: 'primary' }, `Author act (−θ ${fmt(THETA, 4)})`);
  btn.addEventListener('click', () => {
    const author = authorSel.value;
    const ledger = ledgers.find((l) => l.id === author)!;
    if (ledger.burnBal < THETA) {
      actLog.unshift(`✗ ${author}: W1 refuses — balance ${fmt(ledger.burnBal, 3)} < θ`);
      update();
      return;
    }
    const family = familySel.value;
    const target = targetSel.value;
    const pd = Number(s1.input.value);
    const pi = Number(s2.input.value);
    ledger.burnBal -= THETA;
    ledger.actCount += 1;
    deltaActs.set(author, (deltaActs.get(author) ?? 0) + 1);
    authoredCount++;
    const rec = graph.append({ id: `a${authoredCount}`, family, src: author, tgt: target, pd, pi });
    let vouchNote = '';
    const profileTarget = PROFILE_ACTOR[target];
    if (family === 'Opinion' && profileTarget && profileTarget !== author) {
      const key = `${author}→${profileTarget}`;
      const b = vouchBundles.get(key) ?? { src: author, rcp: profileTarget, pd: 0, pi: 0 };
      b.pd += pd;
      b.pi += pi;
      vouchBundles.set(key, b);
      const netPd = clip(b.pd);
      const netPi = clip(b.pi);
      vouchNote =
        netPd > 0 && netPi > 0
          ? ` · person-vouch → ${profileTarget} (c=${fmt(Math.sqrt(netPd * netPi), 3)})`
          : ' · folded bundle not positive — resolves to self';
    } else if (family === 'Opinion') {
      vouchNote = ' · artifact-directed — resolves to author';
    }
    actLog.unshift(
      `✓ ${rec.id}: ${author} ${family} → ${target} (${fmt(pd, 2)}, ${fmt(pi, 2)}) · τ=${fmt(rec.tau, 3)} · w=${fmt(rec.weight, 3)}${vouchNote}`,
    );
    selectedEdgeId = rec.id;
    update();
  });

  const form = el('div', { class: 'form-grid' },
    el('label', {}, 'author'), authorSel,
    el('label', {}, 'family'), familySel,
    el('label', {}, 'target'), targetSel,
    el('label', {}, s1.label), s1.row,
    el('label', {}, s2.label), s2.row,
    el('label', {}, ''), btn,
  );
  host.append(form);

  const log = el('div', { class: 'act-log' });
  for (const line of actLog.slice(0, 12)) log.append(el('div', {}, line));
  host.append(log);
}

// ── Wiring ─────────────────────────────────────────────────────────────

function update(): void {
  const solved = solveGraphStanding();
  renderGraph();
  renderInspector();
  renderFeed(solved);
  renderStanding(solved);
  renderAuthor();
}

const viewerSel = document.getElementById('viewer-select') as HTMLSelectElement;
for (const l of REFERENCE_SEEDS) {
  viewerSel.append(el('option', { value: l.id }, `viewer: ${l.id[0]!.toUpperCase()}${l.id.slice(1)}`));
}
viewerSel.value = viewerId;
viewerSel.addEventListener('change', () => {
  viewerId = viewerSel.value;
  update();
});

selectedEdgeId = 'e2';
update();
renderEpoch();
