import { useMemo, useRef, useState } from 'react';

// MMR change over time for the top climbers. Every line starts at 0 (the
// player's MMR at their first Season game) so the y-axis is the delta — the
// climb itself — not who has the highest rating.
//
// Each player has a fixed color (assigned by rank at load, never re-assigned
// on hover). The palette has 8 validated hues; players 9 and 10 reuse hues 1
// and 2 with a dashed stroke so they stay distinguishable. Hovering a legend
// name, table row, or line lifts that player and fades the rest; the
// crosshair snaps to the nearest game time and lists everyone's delta.

const W = 800, H = 360;
const M = { top: 20, right: 150, bottom: 36, left: 56 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

// Validated categorical palette (light surface), fixed order.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export function seriesStyle(index) {
    return {
        color: PALETTE[index % PALETTE.length],
        dash: index >= PALETTE.length ? '7 5' : null,
    };
}

const fmtDate = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDateLong = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const fmtDelta = (v) => (v > 0 ? '+' : '') + Math.round(v).toLocaleString();

function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const rough = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || mag * 10;
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step / 2; v += step) ticks.push(Math.round(v));
    return ticks;
}

// Point value: the server's normalized climb (game results only) when present,
// otherwise the raw change from the start MMR.
const pointDelta = (p, pt) => (pt.delta != null ? pt.delta : pt.mmr - p.startMmr);

// Delta at time t: last snapshot at or before t.
function deltaAt(p, t) {
    let v = null;
    for (const pt of p.points) { if (pt.t <= t) v = pointDelta(p, pt); else break; }
    return v;
}

export default function MmrChart({ players, highlighted, onHighlight }) {
    const [hoverT, setHoverT] = useState(null);
    const [pointer, setPointer] = useState(null);
    const svgRef = useRef(null);

    const model = useMemo(() => {
        const deltas = players.flatMap(p => p.points.map(pt => ({ t: pt.t, d: pointDelta(p, pt) })));
        if (!deltas.length) return null;
        const tMin = Math.min(...deltas.map(p => p.t));
        const tMax = Math.max(...deltas.map(p => p.t));
        const vMin = Math.min(0, ...deltas.map(p => p.d));
        const vMax = Math.max(0, ...deltas.map(p => p.d));
        const pad = Math.max(25, (vMax - vMin) * 0.08);
        const yTicks = niceTicks(vMin - pad, vMax + pad, 5);
        const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
        const x = (t) => M.left + ((t - tMin) / Math.max(1, tMax - tMin)) * PW;
        const y = (v) => M.top + PH - ((v - y0) / Math.max(1, y1 - y0)) * PH;
        const times = [...new Set(deltas.map(p => p.t))].sort((a, b) => a - b);
        const xTicks = [];
        const n = Math.min(6, times.length);
        for (let i = 0; i < n; i++) xTicks.push(tMin + ((tMax - tMin) * i) / Math.max(1, n - 1));
        return { x, y, yTicks, xTicks, times };
    }, [players]);

    if (!model) return <div className="mmr-chart-empty">No MMR history yet.</div>;
    const { x, y, yTicks, xTicks, times } = model;

    const series = players.map((p, i) => ({
        p,
        ...seriesStyle(i),
        d: p.points.map((pt, k) => `${k ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pointDelta(p, pt)).toFixed(1)}`).join(' '),
    }));

    const onMove = (e) => {
        const rect = svgRef.current.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const py = ((e.clientY - rect.top) / rect.height) * H;
        if (px < M.left || px > W - M.right) { setHoverT(null); setPointer(null); onHighlight?.(null, 'chart'); return; }
        let best = times[0], bestD = Infinity;
        for (const t of times) { const d = Math.abs(x(t) - px); if (d < bestD) { bestD = d; best = t; } }
        setHoverT(best);
        setPointer({ clientX: e.clientX - rect.left, clientY: e.clientY - rect.top, w: rect.width, h: rect.height });
        // Hovering a line directly: nearest series (vertically) at this time
        let nearest = null, nearestD = 14;
        for (const p of players) {
            const v = deltaAt(p, best);
            if (v == null) continue;
            const d = Math.abs(y(v) - py);
            if (d < nearestD) { nearestD = d; nearest = p.accountId; }
        }
        onHighlight?.(nearest, 'chart');
    };
    const onLeave = () => { setHoverT(null); setPointer(null); onHighlight?.(null, 'chart'); };

    const activeIdx = players.findIndex(p => p.accountId === highlighted);
    const labeledIdx = activeIdx >= 0 ? activeIdx : 0; // direct label: the lifted player, else the top climber
    const rows = hoverT != null
        ? series.map(s => ({ s, v: deltaAt(s.p, hoverT) })).filter(r => r.v != null).sort((a, b) => b.v - a.v)
        : [];

    let tipStyle = null;
    if (pointer && rows.length) {
        const flip = pointer.clientX / pointer.w > 0.6;
        tipStyle = {
            left: flip ? undefined : pointer.clientX + 16,
            right: flip ? pointer.w - pointer.clientX + 16 : undefined,
            top: Math.max(0, Math.min(pointer.clientY + 12, pointer.h - 22 * (rows.length + 1))),
        };
    }

    const fading = highlighted != null;
    const labeled = series[labeledIdx];
    const labeledEnd = labeled.p.points[labeled.p.points.length - 1];

    return (
        <div className="mmr-chart-wrap">
            <svg ref={svgRef} className="mmr-chart" viewBox={`0 0 ${W} ${H}`} role="img"
                aria-label="Garg MMR change since the start of the season for the top climbers"
                onPointerMove={onMove} onPointerLeave={onLeave}>
                {yTicks.map(v => (
                    <g key={v}>
                        <line className={'mmr-grid' + (v === 0 ? ' zero' : '')} x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
                        <text className="mmr-tick" x={M.left - 8} y={y(v) + 4} textAnchor="end">{fmtDelta(v)}</text>
                    </g>
                ))}
                {xTicks.map((t, i) => (
                    <text key={i} className="mmr-tick" x={x(t)} y={M.top + PH + 20}
                        textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtDate(t)}</text>
                ))}

                {series.filter((_, i) => i !== activeIdx).map(s => (
                    <path key={s.p.accountId} className={'mmr-line' + (fading ? ' faded' : '')} d={s.d}
                        style={{ stroke: s.color, strokeDasharray: s.dash || undefined }} />
                ))}
                {activeIdx >= 0 && (
                    <path className="mmr-line active" d={series[activeIdx].d}
                        style={{ stroke: series[activeIdx].color, strokeDasharray: series[activeIdx].dash || undefined }} />
                )}

                {/* excluded rating adjustments, marked where they happened */}
                {series.map(s => (s.p.adjustments || []).map((a, k) => {
                    const v = deltaAt(s.p, a.t);
                    if (v == null) return null;
                    const dim = fading && s.p.accountId !== highlighted;
                    return (
                        <g key={s.p.accountId + '-adj' + k} className={'mmr-adj' + (dim ? ' faded' : '')} style={{ stroke: s.color }}>
                            <circle cx={x(a.t)} cy={y(v)} r={5} />
                            <title>{s.p.name}: {fmtDelta(a.amount)} rating adjustment (excluded from climb)</title>
                        </g>
                    );
                }))}

                <g className="mmr-end">
                    <circle cx={x(labeledEnd.t)} cy={y(pointDelta(labeled.p, labeledEnd))} r={4} style={{ fill: labeled.color }} />
                    <text x={x(labeledEnd.t) + 10} y={y(pointDelta(labeled.p, labeledEnd)) + 4}>
                        {fmtDelta(pointDelta(labeled.p, labeledEnd))} · {labeled.p.name}
                    </text>
                </g>

                {hoverT != null && (
                    <line className="mmr-crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={M.top} y2={M.top + PH} />
                )}
                {hoverT != null && rows.map(({ s, v }) => (
                    <circle key={s.p.accountId} className="mmr-dot" cx={x(hoverT)} cy={y(v)}
                        r={s.p.accountId === highlighted ? 5 : 3}
                        style={{ fill: s.color, opacity: fading && s.p.accountId !== highlighted ? 0.35 : 1 }} />
                ))}
            </svg>

            {tipStyle && (
                <div className="mmr-tooltip" style={tipStyle}>
                    <div className="mmr-tooltip-date">{fmtDateLong(hoverT)}</div>
                    {rows.map(({ s, v }) => (
                        <div key={s.p.accountId} className={'mmr-tooltip-row' + (s.p.accountId === highlighted ? ' active' : '')}>
                            <span className="mmr-key" style={{ borderTopColor: s.color, borderTopStyle: s.dash ? 'dashed' : 'solid' }} />
                            <span className="mmr-tooltip-value">{fmtDelta(v)}</span>
                            <span className="mmr-tooltip-name">{s.p.name}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
