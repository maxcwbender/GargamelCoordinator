import { useRef } from 'react';
import { toMapPercent, usesWorldCoords } from '../minimap.js';

// The square minimap: background image + structures (towers/barracks from the
// Valve bitmasks) + player dots. Used by the live game page and, in draggable
// mode, by the calibrator.
//
//   structures  { radiant: { towers, barracks }, dire: {...} }  (percent positions)
//   bounds      world-coordinate extent for player dots
//   radiant/dire { towerState, barracksState, players }
//   extraDots   [{ x, y, label, className }] extra percent-positioned markers
//   draggable   when set, structures can be dragged; onMove(team, kind, index, x, y)
export default function Minimap({
    structures, bounds, radiant, dire, extraDots = [], draggable = false, onMove,
    className = '', showEmptyNotice = true, backgroundUrl = null,
}) {
    const mapRef = useRef(null);
    const allPlayers = [...(radiant?.players || []), ...(dire?.players || [])];
    const worldMode = usesWorldCoords(allPlayers);
    const positioned = allPlayers.filter(p => p.posX != null && p.posY != null);

    const percentFromEvent = (e) => {
        const rect = mapRef.current.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        return { x: Math.round(Math.min(100, Math.max(0, x)) * 10) / 10, y: Math.round(Math.min(100, Math.max(0, y)) * 10) / 10 };
    };

    const dragHandlers = (team, kind, index) => {
        if (!draggable) return {};
        return {
            onPointerDown: (e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.dataset.dragging = '1';
            },
            onPointerMove: (e) => {
                if (e.currentTarget.dataset.dragging !== '1') return;
                const { x, y } = percentFromEvent(e);
                onMove?.(team, kind, index, x, y);
            },
            onPointerUp: (e) => { delete e.currentTarget.dataset.dragging; },
            onPointerCancel: (e) => { delete e.currentTarget.dataset.dragging; },
        };
    };

    const renderStructures = (team, state) => {
        const s = structures[team];
        const towerState = state?.towerState ?? 0x7FF;
        const barracksState = state?.barracksState ?? 0x3F;
        return (
            <>
                {s.towers.map((t, i) => (
                    <div
                        key={'t' + t.bit}
                        className={`tower ${team}${(towerState & (1 << t.bit)) ? '' : ' destroyed'}${draggable ? ' draggable' : ''}`}
                        style={{ left: t.x + '%', top: t.y + '%' }}
                        title={`${team === 'radiant' ? 'Radiant' : 'Dire'} ${t.label} (bit ${t.bit}) — ${t.x}%, ${t.y}%`}
                        {...dragHandlers(team, 'towers', i)}
                    />
                ))}
                {s.barracks.map((r, i) => (
                    <div
                        key={'r' + r.bit}
                        className={`barracks ${team}${(barracksState & (1 << r.bit)) ? '' : ' destroyed'}${draggable ? ' draggable' : ''}`}
                        style={{ left: r.x + '%', top: r.y + '%' }}
                        title={`${team === 'radiant' ? 'Radiant' : 'Dire'} ${r.label} barracks — ${r.x}%, ${r.y}%`}
                        {...dragHandlers(team, 'barracks', i)}
                    />
                ))}
            </>
        );
    };

    const renderDots = (players, team) => (players || [])
        .filter(p => p.posX != null && p.posY != null)
        .map((p, i) => {
            const { x, y } = toMapPercent(p.posX, p.posY, bounds, worldMode);
            const heroLabel = p.heroName ? p.heroName + ' - ' : '';
            return (
                <div
                    key={p.accountId || `${team}-${i}`}
                    className={`player-dot ${team}${p.respawnTimer > 0 ? ' dead' : ''}`}
                    style={{ left: x + '%', top: y + '%' }}
                    title={`${heroLabel}${p.name} (Lvl ${p.level})\nraw ${Math.round(p.posX)}, ${Math.round(p.posY)} → ${x.toFixed(1)}%, ${y.toFixed(1)}%`}
                />
            );
        });

    return (
        <div
            ref={mapRef}
            className={`minimap ${className}`.trim()}
            style={backgroundUrl ? { backgroundImage: `url("${backgroundUrl}")` } : undefined}
        >
            <div className="minimap-grid" />
            {renderStructures('radiant', radiant)}
            {renderStructures('dire', dire)}
            {renderDots(radiant?.players, 'radiant')}
            {renderDots(dire?.players, 'dire')}
            {extraDots.map((d, i) => (
                <div key={'x' + i} className={`extra-dot ${d.className || ''}`} style={{ left: d.x + '%', top: d.y + '%' }} title={d.label} />
            ))}
            {showEmptyNotice && positioned.length === 0 && (
                <div className="minimap-no-positions">Position data not available</div>
            )}
        </div>
    );
}
