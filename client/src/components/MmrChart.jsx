import { useMemo, useRef, useState } from 'react';

// MMR-over-time line chart for the top climbers. One y-axis (MMR), time on x.
// Identity is carried by the ranked table beside the chart (its rows are the
// legend); every line is drawn in a muted ink and the hovered / pinned player
// is lifted into the accent color with a direct end label — emphasis instead
// of ten competing hues. Crosshair snaps to the nearest game time and the
// tooltip lists every player's MMR at that moment.

const W = 800, H = 360;
const M = { top: 20, right: 150, bottom: 36, left: 56 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

const fmtDate = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDateLong = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

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

// MMR of a player at time t: the last snapshot at or before t (step-wise).
function valueAt(points, t) {
    let v = null;
    for (const p of points) { if (p.t <= t) v = p.mmr; else break; }
    return v;
}

export default function MmrChart({ players, highlighted, onHighlight }) {
    const [hoverT, setHoverT] = useState(null);
    const [pointer, setPointer] = useState(null);
    const svgRef = useRef(null);

    const model = useMemo(() => {
        const pts = players.flatMap(p => p.points);
        if (!pts.length) return null;
        const tMin = Math.min(...pts.map(p => p.t));
        const tMax = Math.max(...pts.map(p => p.t));
        const vMin = Math.min(...pts.map(p => p.mmr));
        const vMax = Math.max(...pts.map(p => p.mmr));
        const pad = Math.max(50, (vMax - vMin) * 0.08);
        const yTicks = niceTicks(vMin - pad, vMax + pad, 5);
        const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
        const x = (t) => M.left + ((t - tMin) / Math.max(1, tMax - tMin)) * PW;
        const y = (v) => M.top + PH - ((v - y0) / Math.max(1, y1 - y0)) * PH;
        const times = [...new Set(pts.map(p => p.t))].sort((a, b) => a - b);
        // ~6 evenly spaced x ticks
        const xTicks = [];
        const n = Math.min(6, times.length);
        for (let i = 0; i < n; i++) xTicks.push(tMin + ((tMax - tMin) * i) / Math.max(1, n - 1));
        return { tMin, tMax, x, y, yTicks, xTicks, times };
    }, [players]);

    if (!model) return <div className="mmr-chart-empty">No MMR history yet.</div>;
    const { x, y, yTicks, xTicks, times } = model;

    const paths = players.map(p => ({
        accountId: p.accountId,
        d: p.points.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.mmr).toFixed(1)}`).join(' '),
        end: p.points[p.points.length - 1],
    }));

    const onMove = (e) => {
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const py = ((e.clientY - rect.top) / rect.height) * H;
        if (px < M.left || px > W - M.right) { setHoverT(null); setPointer(null); return; }
        // Snap the crosshair to the nearest game time
        let best = times[0], bestD = Infinity;
        for (const t of times) { const d = Math.abs(x(t) - px); if (d < bestD) { bestD = d; best = t; } }
        setHoverT(best);
        setPointer({ x: px, y: py, clientX: e.clientX - rect.left, clientY: e.clientY - rect.top, w: rect.width, h: rect.height });
        // Hover a line directly: the series whose value at this time is closest to the pointer
        let nearest = null, nearestD = 14;
        for (const p of players) {
            const v = valueAt(p.points, best);
            if (v == null) continue;
            const d = Math.abs(y(v) - py);
            if (d < nearestD) { nearestD = d; nearest = p.accountId; }
        }
        onHighlight?.(nearest, 'chart');
    };
    const onLeave = () => { setHoverT(null); setPointer(null); onHighlight?.(null, 'chart'); };

    const active = players.find(p => p.accountId === highlighted) || null;
    // Selective direct label: the highlighted player, or the top climber when nothing is highlighted
    const labeled = active || players[0];
    const rows = hoverT != null
        ? players.map(p => ({ p, v: valueAt(p.points, hoverT) })).filter(r => r.v != null).sort((a, b) => b.v - a.v)
        : [];

    // Tooltip placement (HTML overlay, flips near the right edge)
    let tipStyle = null;
    if (pointer && rows.length) {
        const left = pointer.clientX / pointer.w > 0.6 ? undefined : pointer.clientX + 16;
        const right = pointer.clientX / pointer.w > 0.6 ? pointer.w - pointer.clientX + 16 : undefined;
        tipStyle = { left, right, top: Math.min(pointer.clientY + 12, pointer.h - 24 * (rows.length + 1)) };
    }

    return (
        <div className="mmr-chart-wrap">
            <svg ref={svgRef} className="mmr-chart" viewBox={`0 0 ${W} ${H}`} role="img"
                aria-label="Garg MMR over time for the top climbers this season"
                onPointerMove={onMove} onPointerLeave={onLeave}>
                {/* gridlines + y axis */}
                {yTicks.map(v => (
                    <g key={v}>
                        <line className="mmr-grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
                        <text className="mmr-tick" x={M.left - 8} y={y(v) + 4} textAnchor="end">{v.toLocaleString()}</text>
                    </g>
                ))}
                <line className="mmr-axis" x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH} />
                {xTicks.map((t, i) => (
                    <text key={i} className="mmr-tick" x={x(t)} y={M.top + PH + 20} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtDate(t)}</text>
                ))}

                {/* muted lines first, highlighted on top */}
                {paths.filter(p => p.accountId !== highlighted).map(p => (
                    <path key={p.accountId} className="mmr-line" d={p.d} />
                ))}
                {paths.filter(p => p.accountId === highlighted).map(p => (
                    <path key={p.accountId} className="mmr-line active" d={p.d} />
                ))}

                {/* end marker + direct label for the labeled series */}
                {labeled && (() => {
                    const pt = labeled.points[labeled.points.length - 1];
                    const isActive = active && active.accountId === labeled.accountId;
                    return (
                        <g className={'mmr-end' + (isActive ? ' active' : '')}>
                            <circle cx={x(pt.t)} cy={y(pt.mmr)} r={4} />
                            <text x={x(pt.t) + 10} y={y(pt.mmr) + 4}>{labeled.name} · {pt.mmr.toLocaleString()}</text>
                        </g>
                    );
                })()}

                {/* crosshair */}
                {hoverT != null && (
                    <line className="mmr-crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={M.top} y2={M.top + PH} />
                )}
                {hoverT != null && rows.map(({ p, v }) => (
                    <circle key={p.accountId} className={'mmr-dot' + (p.accountId === highlighted ? ' active' : '')} cx={x(hoverT)} cy={y(v)} r={p.accountId === highlighted ? 5 : 3} />
                ))}
            </svg>

            {tipStyle && (
                <div className="mmr-tooltip" style={tipStyle}>
                    <div className="mmr-tooltip-date">{fmtDateLong(hoverT)}</div>
                    {rows.map(({ p, v }) => (
                        <div key={p.accountId} className={'mmr-tooltip-row' + (p.accountId === highlighted ? ' active' : '')}>
                            <span className="mmr-key" />
                            <span className="mmr-tooltip-value">{v.toLocaleString()}</span>
                            <span className="mmr-tooltip-name">{p.name}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
