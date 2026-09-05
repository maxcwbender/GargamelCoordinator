// Minimap geometry for the live game page.
//
// Two coordinate systems meet here:
//   * Structure positions are percentages of the square minimap image
//     (x → right, y → down, origin top-left). They depend entirely on the
//     background image in client/public/minimap_background.png, so they are
//     tuned visually with the calibration mode (/livegame?calibrate=1) and
//     pasted back into DEFAULT_STRUCTURES below.
//   * Live player positions from Steam's GetLiveLeagueGames are Dota WORLD
//     coordinates (map center = 0,0; fountains near ±6800). They are mapped to
//     percentages with DEFAULT_BOUNDS — the world extent the background covers.
//     If dots sit slightly off the lanes, adjust the bounds in calibration
//     mode (a bigger |bound| shrinks everything toward the center).
//
// Legacy: OpenDota-style 0–255 grid positions are still accepted (detected
// automatically when every value is within 0–255).

export const DEFAULT_BOUNDS = { minX: -8288, maxX: 8288, minY: -8288, maxY: 8288 };

// Tower bits (Valve tower_state): 0 top T1, 1 top T2, 2 top T3, 3 mid T1,
// 4 mid T2, 5 mid T3, 6 bot T1, 7 bot T2, 8 bot T3, 9 ancient top, 10 ancient bot.
// Barracks bits: 0 top melee, 1 top ranged, 2 mid melee, 3 mid ranged,
// 4 bot melee, 5 bot ranged.
// Positions below were read off a reference minimap (Radiant bottom-left,
// Dire top-right) — calibrate against the real background before trusting.
export const DEFAULT_STRUCTURES = {
    radiant: {
        towers: [
            { bit: 0, label: 'Top T1', x: 15.2, y: 38.7 },
            { bit: 1, label: 'Top T2', x: 14.8, y: 56.2 },
            { bit: 2, label: 'Top T3', x: 11.6, y: 72.6 },
            { bit: 3, label: 'Mid T1', x: 43.5, y: 59.7 },
            { bit: 4, label: 'Mid T2', x: 31.2, y: 69.2 },
            { bit: 5, label: 'Mid T3', x: 23.1, y: 77.5 },
            { bit: 6, label: 'Bot T1', x: 83.0, y: 90.6 },
            { bit: 7, label: 'Bot T2', x: 49.0, y: 90.8 },
            { bit: 8, label: 'Bot T3', x: 29.5, y: 90.8 },
            { bit: 9, label: 'Ancient T4 (top)', x: 16.8, y: 82.6 },
            { bit: 10, label: 'Ancient T4 (bot)', x: 19.5, y: 85.0 },
        ],
        barracks: [
            { bit: 0, label: 'Top Melee', x: 13.3, y: 74.8 },
            { bit: 1, label: 'Top Ranged', x: 11.0, y: 76.5 },
            { bit: 2, label: 'Mid Melee', x: 25.5, y: 79.6 },
            { bit: 3, label: 'Mid Ranged', x: 23.6, y: 81.2 },
            { bit: 4, label: 'Bot Melee', x: 31.5, y: 93.0 },
            { bit: 5, label: 'Bot Ranged', x: 28.5, y: 93.0 },
        ],
    },
    dire: {
        towers: [
            { bit: 0, label: 'Top T1', x: 23.8, y: 11.8 },
            { bit: 1, label: 'Top T2', x: 52.8, y: 11.8 },
            { bit: 2, label: 'Top T3', x: 74.5, y: 13.0 },
            { bit: 3, label: 'Mid T1', x: 58.9, y: 48.6 },
            { bit: 4, label: 'Mid T2', x: 67.5, y: 37.1 },
            { bit: 5, label: 'Mid T3', x: 77.0, y: 24.0 },
            { bit: 6, label: 'Bot T1', x: 90.2, y: 61.8 },
            { bit: 7, label: 'Bot T2', x: 91.1, y: 49.1 },
            { bit: 8, label: 'Bot T3', x: 91.1, y: 30.7 },
            { bit: 9, label: 'Ancient T4 (top)', x: 82.0, y: 16.5 },
            { bit: 10, label: 'Ancient T4 (bot)', x: 84.5, y: 19.0 },
        ],
        barracks: [
            { bit: 0, label: 'Top Melee', x: 76.5, y: 14.5 },
            { bit: 1, label: 'Top Ranged', x: 78.5, y: 16.5 },
            { bit: 2, label: 'Mid Melee', x: 78.5, y: 22.0 },
            { bit: 3, label: 'Mid Ranged', x: 80.5, y: 23.5 },
            { bit: 4, label: 'Bot Melee', x: 88.5, y: 28.0 },
            { bit: 5, label: 'Bot Ranged', x: 88.5, y: 31.5 },
        ],
    },
};

// ─── Per-browser calibration override ────────────────────────────────────────
// The calibrator can store a draft here so the live page uses it immediately,
// before the values are pasted into this file and deployed.
const STORAGE_KEY = 'minimapCalibration';

export function loadCalibration() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && parsed.structures && parsed.bounds ? parsed : null;
    } catch { return null; }
}

export function saveCalibration(config) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ structures: config.structures, bounds: config.bounds })); } catch { /* ignore */ }
}

export function clearCalibration() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function getMinimapConfig() {
    const saved = loadCalibration();
    return {
        structures: saved?.structures || DEFAULT_STRUCTURES,
        bounds: saved?.bounds || DEFAULT_BOUNDS,
        overridden: !!saved,
    };
}

export const cloneStructures = (s) => JSON.parse(JSON.stringify(s));

// ─── Coordinate conversion ───────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Legacy 0–255 grid vs world coordinates: world data has negatives and/or
// values far above 255, so one look at all players decides the mode.
export function usesWorldCoords(players) {
    return players.some(p => p.posX != null && p.posY != null
        && (p.posX < 0 || p.posY < 0 || p.posX > 255 || p.posY > 255));
}

export function toMapPercent(posX, posY, bounds, worldMode) {
    let x, y;
    if (worldMode) {
        x = ((posX - bounds.minX) / (bounds.maxX - bounds.minX)) * 100;
        y = 100 - ((posY - bounds.minY) / (bounds.maxY - bounds.minY)) * 100;
    } else {
        x = (posX / 255) * 100;
        y = 100 - (posY / 255) * 100;
    }
    return { x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
}

// JS source for pasting the calibrated values back into this file.
export function formatCalibrationSource({ structures, bounds }) {
    const fmt = (n) => Number(n).toFixed(1);
    const list = (arr) => arr.map(s => `            { bit: ${s.bit}, label: ${JSON.stringify(s.label)}, x: ${fmt(s.x)}, y: ${fmt(s.y)} },`).join('\n');
    const team = (t) => `    ${t}: {\n        towers: [\n${list(structures[t].towers)}\n        ],\n        barracks: [\n${list(structures[t].barracks)}\n        ],\n    },`;
    return `export const DEFAULT_BOUNDS = { minX: ${bounds.minX}, maxX: ${bounds.maxX}, minY: ${bounds.minY}, maxY: ${bounds.maxY} };\n\n`
        + `export const DEFAULT_STRUCTURES = {\n${team('radiant')}\n${team('dire')}\n};\n`;
}
