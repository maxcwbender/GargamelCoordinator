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

// Border baked into the background image, as a percentage of the image on
// each side. The map area inside the border is stretched to fill the box, so
// structure/dot percentages always refer to the playable map, not the file.
// Calibration mode can auto-detect a black border.
export const DEFAULT_INSET = { top: 6.5, right: 5.8, bottom: 8.3, left: 5.8 };

// CSS to show only the map area (inside the inset) stretched edge to edge.
export function backgroundStyleForInset(inset) {
    const t = (inset?.top || 0) / 100, r = (inset?.right || 0) / 100, b = (inset?.bottom || 0) / 100, l = (inset?.left || 0) / 100;
    const w = 1 - l - r, h = 1 - t - b;
    if (w <= 0.1 || h <= 0.1) return {};
    const px = (l + r) > 0 ? (l / (l + r)) * 100 : 0;
    const py = (t + b) > 0 ? (t / (t + b)) * 100 : 0;
    return {
        backgroundSize: `${(100 / w).toFixed(3)}% ${(100 / h).toFixed(3)}%`,
        backgroundPosition: `${px.toFixed(3)}% ${py.toFixed(3)}%`,
        backgroundRepeat: 'no-repeat',
    };
}

// Tower bits (Valve tower_state): 0 top T1, 1 top T2, 2 top T3, 3 mid T1,
// 4 mid T2, 5 mid T3, 6 bot T1, 7 bot T2, 8 bot T3, 9 ancient top, 10 ancient bot.
// Barracks bits: 0 top melee, 1 top ranged, 2 mid melee, 3 mid ranged,
// 4 bot melee, 5 bot ranged.
// Positions calibrated against the deployed background via /livegame?calibrate=1
export const DEFAULT_STRUCTURES = {
    radiant: {
        towers: [
            { bit: 0, label: "Top T1", x: 15.2, y: 38.7 },
            { bit: 1, label: "Top T2", x: 14.8, y: 56.2 },
            { bit: 2, label: "Top T3", x: 14.7, y: 68.1 },
            { bit: 3, label: "Mid T1", x: 42.3, y: 57.2 },
            { bit: 4, label: "Mid T2", x: 33.0, y: 65.9 },
            { bit: 5, label: "Mid T3", x: 25.7, y: 73.3 },
            { bit: 6, label: "Bot T1", x: 76.5, y: 84.6 },
            { bit: 7, label: "Bot T2", x: 48.9, y: 85.0 },
            { bit: 8, label: "Bot T3", x: 30.2, y: 83.9 },
            { bit: 9, label: "Ancient T4 (top)", x: 17.7, y: 77.7 },
            { bit: 10, label: "Ancient T4 (bot)", x: 19.9, y: 80.6 },
        ],
        barracks: [
            { bit: 0, label: "Top Melee", x: 17.0, y: 71.1 },
            { bit: 1, label: "Top Ranged", x: 12.8, y: 71.1 },
            { bit: 2, label: "Mid Melee", x: 25.7, y: 76.3 },
            { bit: 3, label: "Mid Ranged", x: 22.9, y: 73.7 },
            { bit: 4, label: "Bot Melee", x: 27.2, y: 85.3 },
            { bit: 5, label: "Bot Ranged", x: 27.4, y: 82.2 },
        ],
    },
    dire: {
        towers: [
            { bit: 0, label: "Top T1", x: 23.1, y: 17.6 },
            { bit: 1, label: "Top T2", x: 48.6, y: 16.6 },
            { bit: 2, label: "Top T3", x: 68.0, y: 18.1 },
            { bit: 3, label: "Mid T1", x: 54.0, y: 45.7 },
            { bit: 4, label: "Mid T2", x: 64.7, y: 37.6 },
            { bit: 5, label: "Mid T3", x: 73.4, y: 30.1 },
            { bit: 6, label: "Bot T1", x: 83.0, y: 65.2 },
            { bit: 7, label: "Bot T2", x: 84.4, y: 48.7 },
            { bit: 8, label: "Bot T3", x: 85.1, y: 34.3 },
            { bit: 9, label: "Ancient T4 (top)", x: 77.6, y: 21.6 },
            { bit: 10, label: "Ancient T4 (bot)", x: 80.4, y: 24.5 },
        ],
        barracks: [
            { bit: 0, label: "Top Melee", x: 70.1, y: 16.7 },
            { bit: 1, label: "Top Ranged", x: 69.8, y: 19.7 },
            { bit: 2, label: "Mid Melee", x: 73.9, y: 27.5 },
            { bit: 3, label: "Mid Ranged", x: 76.0, y: 30.1 },
            { bit: 4, label: "Bot Melee", x: 86.6, y: 32.4 },
            { bit: 5, label: "Bot Ranged", x: 83.0, y: 32.9 },
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ structures: config.structures, bounds: config.bounds, inset: config.inset || DEFAULT_INSET })); } catch { /* ignore */ }
}

export function clearCalibration() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function getMinimapConfig() {
    const saved = loadCalibration();
    return {
        structures: saved?.structures || DEFAULT_STRUCTURES,
        bounds: saved?.bounds || DEFAULT_BOUNDS,
        inset: saved?.inset || DEFAULT_INSET,
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
export function formatCalibrationSource({ structures, bounds, inset = DEFAULT_INSET }) {
    const fmt = (n) => Number(n).toFixed(1);
    const list = (arr) => arr.map(s => `            { bit: ${s.bit}, label: ${JSON.stringify(s.label)}, x: ${fmt(s.x)}, y: ${fmt(s.y)} },`).join('\n');
    const team = (t) => `    ${t}: {\n        towers: [\n${list(structures[t].towers)}\n        ],\n        barracks: [\n${list(structures[t].barracks)}\n        ],\n    },`;
    return `export const DEFAULT_BOUNDS = { minX: ${bounds.minX}, maxX: ${bounds.maxX}, minY: ${bounds.minY}, maxY: ${bounds.maxY} };\n\n`
        + `export const DEFAULT_INSET = { top: ${fmt(inset.top)}, right: ${fmt(inset.right)}, bottom: ${fmt(inset.bottom)}, left: ${fmt(inset.left)} };\n\n`
        + `export const DEFAULT_STRUCTURES = {\n${team('radiant')}\n${team('dire')}\n};\n`;
}
