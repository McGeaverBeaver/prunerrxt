import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';

import { useStorageTrend } from '@/hooks/useApi';
import { formatBytes } from '@/lib/utils';
import type { StorageTrendPoint } from '@/types';

import '@/styles/storage-trends.css';

type Range = 30 | 90;
const RANGES: Range[] = [30, 90];

interface HoverState {
  idx: number;
  leftPx: number;
}

/**
 * Library size over time, and why it moved.
 *
 * The line is the size of everything in the library, one point per day with
 * a live point for right now. The amber bars underneath are what PrunerrXT
 * deleted each day. The tiles above split the change over the window into
 * the two things that can cause it: space reclaimed by deletions and space
 * that arrived (new titles, or files replaced by bigger ones), so a falling
 * line reads as "4.6 TB reclaimed, 0.3 TB added" rather than as a shape.
 * Everything here counts only titles still in the library; deleted titles
 * are history, not storage.
 */
export function StorageTrendsChart() {
  const { t } = useTranslation('dashboard');
  const [days, setDays] = useState<Range>(30);
  const { data, isLoading } = useStorageTrend(days);

  // The chart fills its container: the viewBox width tracks the measured
  // width so 1 viewBox unit = 1 CSS px (crisp text, no aspect stretch).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  const [hover, setHover] = useState<HoverState | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (isLoading || !data || data.points.length === 0) return null;

  const { points, summary, now } = data;
  const n = points.length;

  // ---- geometry (viewBox units = CSS px) ----
  const H = 208;
  const padT = 14;
  const padB = 26;
  const padL = 52;
  const padR = 12;
  const baseY = H - padB;
  const plotH = baseY - padT;
  const innerW = W - padL - padR;

  // The size axis starts at zero so a drop is drawn in proportion to what
  // was there: a line that loses three quarters of its height lost three
  // quarters of the library.
  const maxTotal = Math.max(...points.map((p) => p.totalBytes), 1);
  const maxVal = maxTotal * 1.08;
  const x = (i: number) => (n === 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW);
  const y = (v: number) => baseY - (v / maxVal) * plotH;

  const coords = points.map((p, i) => ({ x: x(i), y: y(p.totalBytes) }));
  const lineD = n > 1 ? coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') : '';
  const areaD = n > 1 ? `${lineD} L${coords[n - 1]!.x.toFixed(1)},${baseY} L${coords[0]!.x.toFixed(1)},${baseY} Z` : '';

  // Reclaimed bars on their own scale, never taller than a quarter of the plot.
  const maxReclaimed = Math.max(...points.map((p) => p.reclaimedBytes), 0);
  const barH = (v: number) => (maxReclaimed > 0 ? (v / maxReclaimed) * plotH * 0.25 : 0);
  const barW = Math.max(3, Math.min(14, (innerW / Math.max(n, 1)) * 0.55));

  const fmtAxis = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtLong = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const labelCount = Math.min(n, W < 480 ? 3 : 5);
  const labelIdx = Array.from({ length: labelCount }, (_, k) => Math.round((k * (n - 1)) / Math.max(labelCount - 1, 1))).filter((idx, pos, arr) => arr.indexOf(idx) === pos);
  const gridFractions = [0, 1 / 3, 2 / 3, 1];

  // Nearest-point selection; the tooltip stays pinned near the top and only
  // tracks horizontally, so it never clips against the card edge.
  const pick = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const localW = el.offsetWidth || rect.width;
    const px = ((clientX - rect.left) / localW) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const TIPW = 212;
    const PAD = 6;
    const center = (x(best) / W) * localW;
    const maxLeft = localW - TIPW - PAD;
    const leftPx = maxLeft < PAD ? (localW - TIPW) / 2 : Math.max(PAD, Math.min(maxLeft, center - TIPW / 2));
    setHover({ idx: best, leftPx });
  };
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => pick(e.clientX, e.currentTarget);
  const handleTouch = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (touch) pick(touch.clientX, e.currentTarget);
  };
  const hovered: StorageTrendPoint | undefined = hover ? points[hover.idx] : undefined;
  const hoveredXY = hover ? coords[hover.idx] : undefined;

  const delta = summary.deltaBytes;
  const direction = delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat';
  const TrendIcon = direction === 'down' ? TrendingDown : direction === 'up' ? TrendingUp : Minus;
  const pct = summary.deltaPct;

  const deltaLabel = (bytes: number): string => (bytes === 0 ? t('chart.noChange', 'no change') : `${bytes < 0 ? '↓' : '↑'} ${formatBytes(Math.abs(bytes))}`);
  const deltaClass = (bytes: number): string => (bytes < 0 ? 'st-delta down' : bytes > 0 ? 'st-delta up' : 'st-delta flat');

  return (
    <div className="sc-card">
      <div className="sc-head">
        <div className="sc-ico">
          <TrendingUp className="w-[18px] h-[18px]" strokeWidth={2} />
        </div>
        <div className="sc-head-t">
          <div className="sc-title">{t('chart.title', 'Storage Trends')}</div>
          <div className="sc-sub">{t('chart.subtitle', 'Library size over the last {{count}} days, and why it moved', { count: days })}</div>
        </div>
        <div className="sc-head-actions">
          <div className="st-range" role="group" aria-label={t('chart.rangeLabel', 'Time range')}>
            {RANGES.map((r) => (
              <button key={r} type="button" className={r === days ? 'on' : undefined} onClick={() => setDays(r)} aria-pressed={r === days}>
                {t('chart.rangeDays', '{{count}}d', { count: r })}
              </button>
            ))}
          </div>
          <div className={`st-trend ${direction}`} title={t('chart.trendTitle', 'Change in library size over the window')}>
            <TrendIcon />
            {direction === 'flat' ? t('chart.noChange', 'no change') : formatBytes(Math.abs(delta))}
            {pct !== null && direction !== 'flat' && <span className="st-trend-pct">{`${pct > 0 ? '+' : ''}${pct}%`}</span>}
          </div>
        </div>
      </div>

      <div className="sc-body">
        <div className="st-tiles">
          <div className="st-tile acc">
            <div className="st-tile-k">{t('chart.tileNow', 'Library now')}</div>
            <div className="st-tile-v">{formatBytes(now.totalBytes)}</div>
            <div className="st-tile-s">{t('chart.tileNowSub', '{{movies}} movies · {{shows}} shows', { movies: now.movieCount, shows: now.showCount })}</div>
          </div>
          <div className="st-tile eme">
            <div className="st-tile-k">{t('chart.tileReclaimed', 'Reclaimed by PrunerrXT')}</div>
            <div className="st-tile-v">{formatBytes(summary.reclaimedBytes)}</div>
            <div className="st-tile-s">{t('chart.tileReclaimedSub', '{{count}} titles deleted in {{days}} days', { count: summary.reclaimedTitles, days })}</div>
          </div>
          <div className="st-tile vio">
            <div className="st-tile-k">{t('chart.tileAdded', 'Added')}</div>
            <div className="st-tile-v">{formatBytes(summary.addedBytes)}</div>
            <div className="st-tile-s">{t('chart.tileAddedSub', 'New titles, or files replaced by larger ones')}</div>
          </div>
        </div>

        <div className="st-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)} onMouseMove={handleMove} onTouchStart={handleTouch} onTouchMove={handleTouch}>
          <svg viewBox={`0 0 ${W} ${H}`} className="st-svg">
            <defs>
              <linearGradient id="stFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#38bdf8" stopOpacity="0.22" />
                <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
              </linearGradient>
            </defs>

            {gridFractions.map((g) => {
              const gy = baseY - g * plotH;
              return (
                <g key={g}>
                  <line className="st-grid" x1={padL} y1={gy} x2={W - padR} y2={gy} />
                  <text className="st-axis st-ylabel" x={padL - 8} y={gy + 3.5} textAnchor="end">
                    {g === 0 ? '0' : formatBytes(maxVal * g)}
                  </text>
                </g>
              );
            })}

            {points.map((p, i) =>
              p.reclaimedBytes > 0 ? (
                <rect
                  key={p.date}
                  className="st-bar"
                  x={x(i) - barW / 2}
                  y={baseY - barH(p.reclaimedBytes)}
                  width={barW}
                  height={barH(p.reclaimedBytes)}
                  rx={1.5}
                />
              ) : null
            )}

            {areaD && <path className="st-area" d={areaD} fill="url(#stFill)" />}
            {lineD && <path className="st-line" d={lineD} />}

            {hoveredXY && <line className="st-guide" x1={hoveredXY.x} y1={padT - 6} x2={hoveredXY.x} y2={baseY} />}
            {!hover && <circle className="st-dot-pt" cx={coords[n - 1]!.x} cy={coords[n - 1]!.y} r={3.4} />}
            {hoveredXY && <circle className="st-dot-hover" cx={hoveredXY.x} cy={hoveredXY.y} r={4.2} />}

            {labelIdx.map((idx) => (
              <text key={idx} className="st-axis" x={x(idx)} y={baseY + 16} textAnchor={idx === 0 ? 'start' : idx === n - 1 ? 'end' : 'middle'}>
                {points[idx]!.live ? t('chart.today', 'Today') : fmtAxis(points[idx]!.date)}
              </text>
            ))}
          </svg>

          {hover && hovered && (
            <div className="st-tip st-tip-wide" style={{ left: hover.leftPx }}>
              <div className="st-tip-date">
                <span className="st-tip-dot" />
                {hovered.live ? t('chart.now', 'Now') : fmtLong(hovered.date)}
              </div>
              <div className="st-tip-row total">
                <span className="k">
                  <span className="st-sw acc" />
                  {t('chart.total', 'Total')}
                </span>
                <span className="v">{formatBytes(hovered.totalBytes)}</span>
              </div>
              <div className="st-tip-row">
                <span className="k">
                  <span className="st-sw vio" />
                  {t('stats.movies', 'Movies')}
                </span>
                <span className="v">{formatBytes(hovered.movieBytes)}</span>
              </div>
              <div className="st-tip-row">
                <span className="k">
                  <span className="st-sw eme" />
                  {t('stats.tvShows', 'TV Shows')}
                </span>
                <span className="v">{formatBytes(hovered.showBytes)}</span>
              </div>
              <div className="st-tip-row">
                <span className="k">
                  <span className="st-sw amb" />
                  {t('chart.tipReclaimed', 'Reclaimed that day')}
                </span>
                <span className="v">{hovered.reclaimedBytes > 0 ? formatBytes(hovered.reclaimedBytes) : '—'}</span>
              </div>
              <div className="st-tip-row">
                <span className="k">{t('chart.tipTitles', 'Titles')}</span>
                <span className="v">{hovered.itemCount}</span>
              </div>
            </div>
          )}
        </div>
        <div className="st-legend">
          <span>
            <span className="st-sw acc" /> {t('chart.legendSize', 'Library size')}
          </span>
          <span>
            <span className="st-sw amb" /> {t('chart.legendReclaimed', 'Reclaimed that day')}
          </span>
        </div>
      </div>

      <div className="sc-foot">
        <div className="sc-foot-cell">
          <div className="sc-foot-k">{t('stats.movies', 'Movies')}</div>
          <div className="sc-foot-v">
            <span className="st-foot-dot vio" />
            {formatBytes(now.movieBytes)}
            <span className={deltaClass(summary.movies.deltaBytes)}>{deltaLabel(summary.movies.deltaBytes)}</span>
          </div>
        </div>
        <div className="sc-foot-div" />
        <div className="sc-foot-cell">
          <div className="sc-foot-k">{t('stats.tvShows', 'TV Shows')}</div>
          <div className="sc-foot-v">
            <span className="st-foot-dot eme" />
            {formatBytes(now.showBytes)}
            <span className={deltaClass(summary.shows.deltaBytes)}>{deltaLabel(summary.shows.deltaBytes)}</span>
          </div>
        </div>
        <div className="sc-foot-div" />
        <div className="sc-foot-cell">
          <div className="sc-foot-k">{t('chart.total', 'Total')}</div>
          <div className="sc-foot-v">
            <span className="st-foot-dot acc" />
            {formatBytes(now.totalBytes)}
            <span className={deltaClass(delta)}>{deltaLabel(delta)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
