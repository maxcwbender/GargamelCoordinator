import { useEffect, useState } from 'react';
import Minimap from './Minimap.jsx';
import {
    DEFAULT_BOUNDS, DEFAULT_STRUCTURES, DEFAULT_INSET, cloneStructures, getMinimapConfig,
    saveCalibration, clearCalibration, formatCalibrationSource, toMapPercent, usesWorldCoords,
} from '../minimap.js';

// /livegame?calibrate=1 — drag every structure onto the real background,
// test world coordinates against the map bounds, then copy the generated
// constants into client/src/minimap.js. "Apply on this browser" stores the
// draft in localStorage so the normal live page uses it right away.
export default function MinimapCalibrator({ liveGames = [] }) {
    const initial = getMinimapConfig();
    const [structures, setStructures] = useState(() => cloneStructures(initial.structures));
    const [bounds, setBounds] = useState({ ...initial.bounds });
    const [inset, setInset] = useState({ ...initial.inset });
    const [detectNote, setDetectNote] = useState('');
    const [overridden, setOverridden] = useState(initial.overridden);
    const [testPoint, setTestPoint] = useState({ x: '-6800', y: '-6400' });
    const [showLive, setShowLive] = useState(true);
    const [copied, setCopied] = useState(false);
    const [selectedGame, setSelectedGame] = useState(0);
    // Preview an alternative background (local file) without deploying it.
    const [previewBackground, setPreviewBackground] = useState(null);
    const [backgroundMissing, setBackgroundMissing] = useState(false);

    useEffect(() => { setCopied(false); }, [structures, bounds, inset]);

    // Detect a missing/broken deployed background so the page says so instead
    // of silently showing a black square.
    useEffect(() => {
        const img = new Image();
        img.onload = () => setBackgroundMissing(false);
        img.onerror = () => setBackgroundMissing(true);
        img.src = '/minimap_background.png';
    }, []);

    const onPickBackground = (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (previewBackground) URL.revokeObjectURL(previewBackground);
        setPreviewBackground(URL.createObjectURL(file));
    };

    const moveStructure = (team, kind, index, x, y) => {
        setStructures(prev => {
            const next = cloneStructures(prev);
            next[team][kind][index] = { ...next[team][kind][index], x, y };
            return next;
        });
    };

    const setStructureField = (team, kind, index, field, value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        moveStructure(team, kind, index,
            field === 'x' ? n : structures[team][kind][index].x,
            field === 'y' ? n : structures[team][kind][index].y);
    };

    const setBound = (key, value) => {
        const n = Number(value);
        if (Number.isFinite(n)) setBounds(b => ({ ...b, [key]: n }));
    };

    const setInsetSide = (side, value) => {
        const n = Number(value);
        if (Number.isFinite(n)) setInset(i => ({ ...i, [side]: Math.max(0, Math.min(40, n)) }));
    };

    // Scan the background for a dark border: walk in from each edge while the
    // whole row/column is near-black, and turn that into percent insets.
    const detectBorder = () => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const W = canvas.width, H = canvas.height, DARK = 40;
                const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
                // A line counts as border when at least 97% of its pixels are dark.
                const rowDark = (y) => { let d = 0; for (let x = 0; x < W; x++) if (lum(x, y) < DARK) d++; return d / W > 0.97; };
                const colDark = (x) => { let d = 0; for (let y = 0; y < H; y++) if (lum(x, y) < DARK) d++; return d / H > 0.97; };
                let top = 0, bottom = 0, left = 0, right = 0;
                while (top < H * 0.4 && rowDark(top)) top++;
                while (bottom < H * 0.4 && rowDark(H - 1 - bottom)) bottom++;
                while (left < W * 0.4 && colDark(left)) left++;
                while (right < W * 0.4 && colDark(W - 1 - right)) right++;
                const r1 = (n, total) => Math.round((n / total) * 1000) / 10;
                const found = { top: r1(top, H), right: r1(right, W), bottom: r1(bottom, H), left: r1(left, W) };
                setInset(found);
                setDetectNote(`Detected border: top ${found.top}%, right ${found.right}%, bottom ${found.bottom}%, left ${found.left}% (${W}x${H}px image)`);
            } catch (err) {
                setDetectNote('Could not read the image pixels (' + err.message + ') - set the insets by hand.');
            }
        };
        img.onerror = () => setDetectNote('Background image failed to load.');
        img.src = previewBackground || '/minimap_background.png';
    };

    const source = formatCalibrationSource({ structures, bounds, inset });

    const copy = async () => {
        try { await navigator.clipboard.writeText(source); setCopied(true); } catch { setCopied(false); }
    };

    const apply = () => { saveCalibration({ structures, bounds, inset }); setOverridden(true); };
    const clear = () => { clearCalibration(); setOverridden(false); };
    const resetDefaults = () => { setStructures(cloneStructures(DEFAULT_STRUCTURES)); setBounds({ ...DEFAULT_BOUNDS }); setInset({ ...DEFAULT_INSET }); setDetectNote(''); };

    const game = showLive ? liveGames[selectedGame] : null;
    const tx = Number(testPoint.x), ty = Number(testPoint.y);
    const testValid = Number.isFinite(tx) && Number.isFinite(ty);
    const testPct = testValid ? toMapPercent(tx, ty, bounds, true) : null;
    const extraDots = testPct ? [{ ...testPct, label: `test point ${tx}, ${ty}`, className: 'test' }] : [];

    const livePlayers = game ? [...game.radiant.players, ...game.dire.players] : [];
    const worldMode = usesWorldCoords(livePlayers);

    const structureRows = (team) => ['towers', 'barracks'].map(kind => (
        <div key={kind} className="calib-structs">
            <div className="calib-structs-title">{team} {kind}</div>
            {structures[team][kind].map((s, i) => (
                <div key={s.bit} className="calib-struct-row">
                    <span className={`calib-swatch ${kind === 'towers' ? 'sw-tower' : 'sw-barracks'} ${team}`} />
                    <span className="calib-struct-label">{s.label}</span>
                    <input type="number" step="0.1" value={s.x} onChange={e => setStructureField(team, kind, i, 'x', e.target.value)} aria-label="x percent" />
                    <input type="number" step="0.1" value={s.y} onChange={e => setStructureField(team, kind, i, 'y', e.target.value)} aria-label="y percent" />
                </div>
            ))}
        </div>
    ));

    return (
        <div className="calibrator">
            <div className="calib-intro">
                <h2>Minimap calibration</h2>
                <p>
                    Drag each tower and barracks square onto its spot on the background (Radiant bottom-left, Dire top-right).
                    Positions are percentages of the map image, so they only ever need re-doing if the background changes.
                    Live player dots use <strong>world coordinates</strong>; if they land off the lanes during a game, widen or
                    narrow the bounds until fountain-sitters sit in the fountains. When it looks right, copy the constants into
                    <code> client/src/minimap.js</code>, or apply them on this browser to check the live page immediately.
                </p>
                {overridden && <div className="calib-note">A calibration override is active on this browser (the live page is using it).</div>}
                {backgroundMissing && !previewBackground && (
                    <div className="calib-note warn">
                        No background image is deployed at <code>/minimap_background.png</code> — put the map image in
                        <code> client/public/minimap_background.png</code> and rebuild. You can preview a candidate below first.
                    </div>
                )}
            </div>

            <div className="calib-layout">
                <div className="calib-map-col">
                    <Minimap
                        className="large"
                        structures={structures}
                        bounds={bounds}
                        radiant={game ? game.radiant : { players: [] }}
                        dire={game ? game.dire : { players: [] }}
                        extraDots={extraDots}
                        draggable
                        onMove={moveStructure}
                        showEmptyNotice={false}
                        backgroundUrl={previewBackground}
                        inset={inset}
                    />
                    <div className="calib-background">
                        <label className="btn btn-sm btn-ghost calib-file">
                            {previewBackground ? 'Preview a different background…' : 'Preview a background image…'}
                            <input type="file" accept="image/*" onChange={onPickBackground} />
                        </label>
                        {previewBackground && (
                            <button type="button" className="link-btn" onClick={() => { URL.revokeObjectURL(previewBackground); setPreviewBackground(null); }}>
                                back to deployed background
                            </button>
                        )}
                        <span className="calib-muted">
                            Use a clean, square, full-map render (no markers). To make it permanent, save it as
                            <code> client/public/minimap_background.png</code>, commit, and rebuild.
                        </span>
                    </div>
                    <div className="calib-legend">
                        <span><i className="calib-swatch sw-tower radiant" /> Radiant tower</span>
                        <span><i className="calib-swatch sw-tower dire" /> Dire tower</span>
                        <span><i className="calib-swatch sw-barracks radiant" /> barracks</span>
                        <span><i className="calib-swatch dot" /> live player</span>
                        <span><i className="calib-swatch test" /> test point</span>
                    </div>
                    <div className="calib-actions">
                        <button type="button" className="btn btn-sm" onClick={apply}>Apply on this browser</button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={clear} disabled={!overridden}>Clear override</button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={resetDefaults}>Reset to code defaults</button>
                    </div>
                </div>

                <div className="calib-panel">
                    <section>
                        <h3>Image border → map fill</h3>
                        <p className="calib-muted">
                            If the image has a border around the playable map, set how much to trim from each edge (percent of the
                            image). The map inside is stretched to fill the square, so positions refer to the map, not the file.
                        </p>
                        <div className="calib-bounds">
                            {['top', 'right', 'bottom', 'left'].map(k => (
                                <label key={k}>{k} %<input type="number" step="0.1" min="0" max="40" value={inset[k]} onChange={e => setInsetSide(k, e.target.value)} /></label>
                            ))}
                        </div>
                        <div className="calib-actions">
                            <button type="button" className="btn btn-sm btn-ghost" onClick={detectBorder}>Auto-detect black border</button>
                            <button type="button" className="link-btn" onClick={() => { setInset({ ...DEFAULT_INSET }); setDetectNote(''); }}>no border</button>
                        </div>
                        {detectNote && <p className="calib-muted">{detectNote}</p>}
                    </section>

                    <section>
                        <h3>World bounds → player dots</h3>
                        <div className="calib-bounds">
                            {['minX', 'maxX', 'minY', 'maxY'].map(k => (
                                <label key={k}>{k}<input type="number" step="64" value={bounds[k]} onChange={e => setBound(k, e.target.value)} /></label>
                            ))}
                        </div>
                        <div className="calib-test">
                            <span>Test world point</span>
                            <input type="number" value={testPoint.x} onChange={e => setTestPoint(t => ({ ...t, x: e.target.value }))} aria-label="world x" />
                            <input type="number" value={testPoint.y} onChange={e => setTestPoint(t => ({ ...t, y: e.target.value }))} aria-label="world y" />
                            {testPct && <span className="calib-muted">→ {testPct.x.toFixed(1)}%, {testPct.y.toFixed(1)}%</span>}
                        </div>
                        <p className="calib-muted">Radiant fountain is roughly (-6800, -6400); Dire fountain roughly (6800, 6300); mid river center is (0, 0).</p>
                    </section>

                    <section>
                        <h3>Live players {liveGames.length ? '' : '(no live game right now)'}</h3>
                        {liveGames.length > 0 && (
                            <div className="calib-live-head">
                                <label><input type="checkbox" checked={showLive} onChange={e => setShowLive(e.target.checked)} /> show live dots</label>
                                {liveGames.length > 1 && (
                                    <select value={selectedGame} onChange={e => setSelectedGame(Number(e.target.value))}>
                                        {liveGames.map((g, i) => <option key={g.matchId} value={i}>Game {i + 1}</option>)}
                                    </select>
                                )}
                                <span className="calib-muted">{worldMode ? 'world coordinates' : 'legacy 0–255 grid'}</span>
                            </div>
                        )}
                        {livePlayers.length > 0 && (
                            <table className="calib-live">
                                <thead><tr><th>Player</th><th>raw x</th><th>raw y</th><th>→ %</th></tr></thead>
                                <tbody>
                                    {livePlayers.map((p, i) => {
                                        const pct = p.posX != null ? toMapPercent(p.posX, p.posY, bounds, worldMode) : null;
                                        return (
                                            <tr key={p.accountId || i} className={p.team}>
                                                <td>{p.name}</td>
                                                <td>{p.posX != null ? Math.round(p.posX) : '–'}</td>
                                                <td>{p.posY != null ? Math.round(p.posY) : '–'}</td>
                                                <td>{pct ? `${pct.x.toFixed(1)}, ${pct.y.toFixed(1)}` : '–'}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </section>

                    <section>
                        <h3>Structure positions (%)</h3>
                        <div className="calib-struct-cols">
                            <div>{structureRows('radiant')}</div>
                            <div>{structureRows('dire')}</div>
                        </div>
                    </section>

                    <section>
                        <h3>Paste into client/src/minimap.js</h3>
                        <textarea className="calib-source" readOnly value={source} rows={12} />
                        <div className="calib-actions">
                            <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied!' : 'Copy constants'}</button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
