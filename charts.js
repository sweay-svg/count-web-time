// charts.js — Dashboard 图表渲染（纯渲染，不碰 chrome API / 全局 state）。
// 所有动态文本走 textContent / DOM API，不用 innerHTML 拼接数据。
// 统一自定义 tooltip（.chart-tooltip）替代 SVG <title>：即时、样式可控、深浅主题一致。

import { formatDuration } from './utils.js';
import { isZh, uiDate, UI_LOCALE, t } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function longDate(key) {
  return uiDate(parseKey(key), { weekday: 'short', month: isZh ? 'long' : 'short', day: 'numeric' });
}

// 在容器内创建一个跟随鼠标的 tooltip；返回 bind(interactiveEl, title, value)。
// 每次 render 前容器会被清空，因此 tooltip 每次重建。
function makeTooltip(container) {
  container.style.position = 'relative';
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.hidden = true;
  container.append(tip);

  function place(e) {
    const r = container.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let x = e.clientX - r.left + 10;
    const y = e.clientY - r.top - tip.offsetHeight - 10;
    if (x + tw > r.width - 4) x = e.clientX - r.left - tw - 10; // 靠右时翻到鼠标左侧
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }

  return {
    bind(node, title, value) {
      const show = (e) => {
        tip.textContent = '';
        const a = document.createElement('div');
        a.className = 'chart-tip-title';
        a.textContent = title;
        const b = document.createElement('div');
        b.className = 'chart-tip-value';
        b.textContent = value;
        tip.append(a, b);
        tip.hidden = false;
        place(e);
      };
      node.addEventListener('mouseenter', show);
      node.addEventListener('mousemove', place);
      node.addEventListener('mouseleave', () => { tip.hidden = true; });
    }
  };
}

// 图表空态（SKILL 36：没有数据时显示 Empty State）
function renderEmpty(container) {
  container.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'chart-empty';
  empty.textContent = t('chartEmpty');
  container.append(empty);
}

/**
 * 柱状图：series=[{date,total}]，days 决定 X 轴标签密度（7 全标星期 / 30 每 5 天+末日）。
 */
export function renderBarChart(container, series, days) {
  if (!series || series.length === 0 || series.every((s) => s.total <= 0)) {
    renderEmpty(container);
    return;
  }
  container.textContent = '';
  const tooltip = makeTooltip(container);

  const n = series.length;
  const W = 320;
  const H = 140;
  const padX = 4;
  const top = 10;
  const axisH = 16;
  const plotH = H - top - axisH;
  const max = Math.max(1, ...series.map((s) => s.total));
  const slot = (W - padX * 2) / n;
  const barW = Math.max(2, Math.min(slot - 2, n === 7 ? 26 : 9));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  series.forEach((point, i) => {
    const h = point.total > 0 ? Math.max(2, (point.total / max) * plotH) : 0;
    const x = padX + i * slot + (slot - barW) / 2;
    const y = top + plotH - h;
    const isLatest = i === n - 1;
    const title = longDate(point.date);
    const value = formatDuration(point.total, { locale: UI_LOCALE });

    const bar = svgEl('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: h.toFixed(1),
      rx: 2,
      class: isLatest ? 'bar is-latest' : 'bar'
    });
    svg.append(bar);

    // 整槽透明命中区：30 天柱很细，扩大 hover 区域并高亮对应柱
    const hit = svgEl('rect', {
      x: (padX + i * slot).toFixed(1),
      y: 0,
      width: slot.toFixed(1),
      height: H,
      fill: 'transparent',
      'aria-label': `${title} · ${value}`
    });
    hit.addEventListener('mouseenter', () => bar.classList.add('is-hover'));
    hit.addEventListener('mouseleave', () => bar.classList.remove('is-hover'));
    tooltip.bind(hit, title, value);
    svg.append(hit);

    // 7 天全部标星期；30 天每 5 天 + 最后一天标日期数字
    const showLabel = days === 7 || i % 5 === 0 || i === n - 1;
    if (showLabel) {
      const label = svgEl('text', {
        x: (padX + i * slot + slot / 2).toFixed(1),
        y: H - 3,
        'text-anchor': 'middle',
        class: 'axis-label'
      });
      const d = parseKey(point.date);
      label.textContent = days === 7 ? uiDate(d, { weekday: 'short' }) : String(d.getDate());
      svg.append(label);
    }
  });

  container.append(svg);
}

// ---------- 网站分布环形图（Donut） ----------

// 克制配色：主色 + 4 个低频强调色 + 「其他」灰，共 6 色（SKILL 36：不超过 6 种颜色）。
const DIST_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#94a3b8'];
const DIST_TOP = 5; // Top N，其余并入「其他」

/**
 * 网站占比环形图。
 * @param {HTMLElement} container 环形图容器
 * @param {HTMLElement} legendContainer 图例容器
 * @param {{domain: string, ms: number}[]} rows 区间站点（ms DESC）
 * @param {number} total 区间总时长
 */
export function renderDonut(container, legendContainer, rows, total) {
  legendContainer.textContent = '';
  if (!rows || rows.length === 0 || total <= 0) {
    renderEmpty(container);
    return;
  }
  container.textContent = '';
  const tooltip = makeTooltip(container);

  const top = rows.slice(0, DIST_TOP);
  const rest = rows.slice(DIST_TOP);
  const items = top.map((r) => ({ label: r.domain, ms: r.ms }));
  if (rest.length > 0) items.push({ label: t('distOther'), ms: rest.reduce((s, r) => s + r.ms, 0) });

  const SIZE = 108;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = 44;
  const W = 15;
  const C = 2 * Math.PI * R;

  const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', class: 'donut-svg' });
  const segs = [];
  let acc = 0;
  items.forEach((item, i) => {
    const pct = item.ms / total;
    const len = pct * C;
    const seg = svgEl('circle', {
      cx, cy, r: R, fill: 'none',
      stroke: DIST_COLORS[i % DIST_COLORS.length],
      'stroke-width': W,
      'stroke-dasharray': `${len} ${C - len}`,
      'stroke-dashoffset': -acc,
      transform: `rotate(-90 ${cx} ${cy})`,
      class: 'donut-seg'
    });
    tooltip.bind(
      seg,
      item.label,
      `${formatDuration(item.ms, { locale: UI_LOCALE })} · ${Math.round(pct * 100)}%`
    );
    seg.addEventListener('mouseenter', () => highlight(segs, i));
    seg.addEventListener('mouseleave', () => clearHighlight(segs));
    segs.push(seg);
    svg.append(seg);
    acc += len;
  });

  // 中心：活跃网站数（不放总时长，避免抢 Total Time 视觉重点）
  const cv = svgEl('text', { x: cx, y: cy - 1, 'text-anchor': 'middle', class: 'donut-center-value' });
  cv.textContent = String(rows.length);
  const cl = svgEl('text', { x: cx, y: cy + 14, 'text-anchor': 'middle', class: 'donut-center-label' });
  cl.textContent = t('distSites');
  svg.append(cv, cl);
  container.append(svg);

  // 图例：色块 + 域名 + 时长/占比；hover 联动高亮扇区
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'dist-legend-row';
    const swatch = document.createElement('span');
    swatch.className = 'dist-swatch';
    swatch.style.background = DIST_COLORS[i % DIST_COLORS.length];
    const name = document.createElement('span');
    name.className = 'dist-name';
    name.textContent = item.label;
    const meta = document.createElement('span');
    meta.className = 'dist-meta';
    meta.textContent = `${formatDuration(item.ms, { locale: UI_LOCALE })} · ${Math.round((item.ms / total) * 100)}%`;
    row.append(swatch, name, meta);
    row.addEventListener('mouseenter', () => highlight(segs, i));
    row.addEventListener('mouseleave', () => clearHighlight(segs));
    legendContainer.append(row);
  });
}

function highlight(segs, i) {
  segs.forEach((s, j) => s.classList.toggle('is-dim', j !== i));
}
function clearHighlight(segs) {
  segs.forEach((s) => s.classList.remove('is-dim'));
}

// ---------- 单站每日活动折线图（Line） ----------

/**
 * 详情页折线图：series=[{date,total}]，近 30 天每日活动。
 * 线条 + 数据点 + 极淡面积；X 轴每 5 天 + 末日标日期；hover 槽显示具体日期与时长。
 */
export function renderLineChart(container, series) {
  if (!series || series.length === 0 || series.every((s) => s.total <= 0)) {
    renderEmpty(container);
    return;
  }
  container.textContent = '';
  const tooltip = makeTooltip(container);

  const n = series.length;
  const W = 320;
  const H = 140;
  const padX = 6;
  const top = 12;
  const axisH = 16;
  const plotW = W - padX * 2;
  const plotH = H - top - axisH;
  const max = Math.max(1, ...series.map((s) => s.total));
  const stepX = n > 1 ? plotW / (n - 1) : 0;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  const points = series.map((p, i) => ({
    x: padX + i * stepX,
    y: top + plotH - (p.total / max) * plotH,
    point: p,
    i
  }));

  if (points.length >= 2) {
    const areaD = `M ${points[0].x.toFixed(1)} ${top + plotH} ` +
      points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
      ` L ${points[points.length - 1].x.toFixed(1)} ${top + plotH} Z`;
    svg.append(svgEl('path', { d: areaD, class: 'line-area' }));

    const lineD = points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d: `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} ${lineD}`, fill: 'none', class: 'line-path' }));
  }

  points.forEach((p) => {
    svg.append(svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 2.5, class: 'line-dot' }));

    // 整槽透明命中区：hover 显示具体日期与时长
    const hit = svgEl('rect', {
      x: (p.x - stepX / 2).toFixed(1),
      y: 0,
      width: Math.max(stepX, 1).toFixed(1),
      height: H,
      fill: 'transparent'
    });
    tooltip.bind(
      hit,
      longDate(p.point.date),
      formatDuration(p.point.total, { locale: UI_LOCALE })
    );
    svg.append(hit);

    const showLabel = p.i % 5 === 0 || p.i === n - 1;
    if (showLabel) {
      const label = svgEl('text', { x: p.x.toFixed(1), y: H - 3, 'text-anchor': 'middle', class: 'axis-label' });
      label.textContent = String(parseKey(p.point.date).getDate());
      svg.append(label);
    }
  });

  container.append(svg);
}
