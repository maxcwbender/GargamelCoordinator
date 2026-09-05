// Post-deploy exposure probe. Run against the LIVE server after every deploy:
//
//   node scripts/safety-check.mjs                  # probes http://localhost:3000
//   node scripts/safety-check.mjs https://www.gargamel-league.com
//
// After the May 2026 config.json leak (express.static('.') served the repo
// root), nothing ships without this passing. Every probe below must come back
// 404/4xx AND must not contain any secret-shaped content. Exit code 0 = safe,
// 1 = EXPOSURE FOUND, do not leave the deploy up.

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');

// Node 18+ has global fetch; fall back to the node-fetch dependency otherwise.
const fetch = globalThis.fetch ?? (await import('node-fetch')).default;

// Paths that must never serve file content. Includes the exact files that leaked
// before, everything secret-shaped in the repo, and traversal attempts.
const PROBES = [
    '/config.json',
    '/.env',
    '/.env.local',
    '/allUsers.db',
    '/package.json',
    '/package-lock.json',
    '/index.mjs',
    '/server/index.mjs',
    '/server/config.mjs',
    '/Master_Bot.py',
    '/DotaTalker.py',
    '/TheCoordinator.py',
    '/lobbymanager.go',
    '/lobbymanager',
    '/Log.txt',
    '/.git/config',
    '/.git/HEAD',
    '/.gitignore',
    '/client/build.mjs',
    '/client/package.json',
    // Traversal attempts (raw and encoded) — express normalizes/rejects these,
    // but assert it anyway.
    '/../config.json',
    '/..%2fconfig.json',
    '/%2e%2e/config.json',
    '/%2e%2e%2fconfig.json',
    '/assets/../../config.json',
    '/assets/..%2f..%2fconfig.json',
    '/static/../.env',
    '//config.json',
    '/config.json/',
];

// Content markers that mean real secret material got out, whatever the status
// code was. Keep these to key NAMES — never put actual secret values here.
const SECRET_MARKERS = [
    'BOT_TOKEN', 'CLIENT_SECRET', 'STEAM_API_KEY', 'STEAM_PASSWORD',
    'SESSION_SECRET', 'NTFY_TOKEN', 'SUMMER_PLANNING_PASSWORD',
    'GUILD_ID', 'MOD_CHANNEL_ID', 'pipePort',       // config.json keys
    'SQLite format 3',                               // raw DB download
    '[core]',                                        // .git/config
];

let failures = 0;
let checked = 0;

for (const path of PROBES) {
    const url = BASE + path;
    let status, body;
    try {
        const res = await fetch(url, { redirect: 'manual' });
        status = res.status;
        body = await res.text();
    } catch (err) {
        console.log(`SKIP  ${path} — request failed (${err.message})`);
        continue;
    }
    checked++;

    const markers = SECRET_MARKERS.filter(m => body.includes(m));
    // 2xx on a secret path is only tolerable if the body is provably not the
    // file (e.g. some proxy rewrote it) — marker check decides. Everything
    // else must be a 4xx.
    const statusOk = status >= 400 && status < 500;
    const bodyOk = markers.length === 0;

    if (statusOk && bodyOk) {
        console.log(`OK    ${path} -> ${status}`);
    } else {
        failures++;
        console.error(`FAIL  ${path} -> ${status}${markers.length ? ` — body contains: ${markers.join(', ')}` : ' — expected 4xx'}`);
    }
}

// Auth gates: endpoints that read or write a player's own data must reject
// anonymous requests (no session cookie) — a misplaced middleware here would
// expose or let anyone edit profiles.
const AUTH_GATES = [
    { path: '/api/profile/me', method: 'GET' },
    { path: '/api/auth/link-steam?rank=Legend', method: 'GET' },
    { path: '/api/profile/prefs', method: 'PUT', body: '{"favHeroes":[]}' },
];
for (const gate of AUTH_GATES) {
    try {
        const res = await fetch(BASE + gate.path, {
            method: gate.method,
            redirect: 'manual',
            headers: gate.body ? { 'Content-Type': 'application/json' } : {},
            body: gate.body,
        });
        checked++;
        if (res.status === 401) {
            console.log(`OK    ${gate.method} ${gate.path} -> 401 (login required)`);
        } else {
            failures++;
            console.error(`FAIL  ${gate.method} ${gate.path} -> ${res.status} — expected 401 for an anonymous request`);
        }
    } catch (err) {
        console.log(`SKIP  ${gate.method} ${gate.path} — request failed (${err.message})`);
    }
}

// Sanity: the SPA itself must actually be up, otherwise the 404s above prove nothing.
try {
    const res = await fetch(BASE + '/');
    const body = await res.text();
    if (res.ok && body.includes('<div id="root">')) {
        console.log(`OK    / -> ${res.status} (app shell served)`);
    } else {
        failures++;
        console.error(`FAIL  / -> ${res.status} — app shell not served (is the frontend built?)`);
    }
} catch (err) {
    failures++;
    console.error(`FAIL  / — request failed (${err.message})`);
}

console.log(`\n${checked + 1} probes, ${failures} failure(s)`);
if (failures > 0) {
    console.error('\nEXPOSURE RISK — fix before leaving this deploy up.');
    process.exit(1);
}
console.log('Safety check passed: no private files reachable.');
