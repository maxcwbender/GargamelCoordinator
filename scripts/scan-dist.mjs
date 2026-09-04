// Build-output secret scan. Runs automatically after `npm run build` and fails
// the build if anything secret-shaped ended up inside client/dist — the files
// that get served to every visitor.
//
// Two layers:
//   1. Marker scan: names of secret env vars / config keys must not appear in
//      any built file (they have no business in frontend code at all).
//   2. Value scan: the ACTUAL values from .env and config.json (loaded here,
//      never printed) must not appear in any built file. This catches a secret
//      that got inlined under a different name.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'client', 'dist');

if (!existsSync(DIST)) {
    console.error(`No build output at ${DIST} — run the build first.`);
    process.exit(1);
}

const MARKERS = [
    'BOT_TOKEN', 'CLIENT_SECRET', 'STEAM_API_KEY', 'STEAM_PASSWORD_0', 'STEAM_PASSWORD_1',
    'STEAM_USERNAME_0', 'STEAM_USERNAME_1', 'SESSION_SECRET', 'NTFY_TOKEN',
    'SUMMER_PLANNING_PASSWORD', 'process.env.',
];

// Keys whose values are public by design and expected to appear in frontend
// code — the Discord OAuth client id is baked into the register link, and the
// site's own URL shows up inside the OAuth redirect parameter.
const PUBLIC_KEYS = new Set(['CLIENT_ID', 'SITE_URL', 'BOT_OAUTH_SITE', 'NTFY_SERVER']);

// Load real secret values (values are never printed — only key names are; the
// values are used solely for containment checks).
const secretValues = []; // [{ key, value }]
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !PUBLIC_KEYS.has(m[1])) {
            const v = m[2].trim().replace(/^["']|["']$/g, '');
            if (v.length >= 8) secretValues.push({ key: `.env:${m[1]}`, value: v }); // ignore short/boolean-ish values
        }
    }
}
const cfgPath = join(ROOT, 'config.json');
if (existsSync(cfgPath)) {
    try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        for (const [k, v] of Object.entries(cfg)) {
            if (PUBLIC_KEYS.has(k)) continue;
            if (typeof v === 'string' && v.length >= 8) secretValues.push({ key: `config.json:${k}`, value: v });
        }
    } catch { /* unreadable config is not this script's problem */ }
}

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else yield p;
    }
}

let failures = 0;
let files = 0;
for (const file of walk(DIST)) {
    // Only text-ish outputs can carry secrets worth scanning.
    if (!/\.(js|css|html|json|map|txt|svg)$/.test(file)) continue;
    files++;
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    for (const marker of MARKERS) {
        if (content.includes(marker)) {
            failures++;
            console.error(`FAIL  ${rel} contains marker "${marker}"`);
        }
    }
    for (const { key, value } of secretValues) {
        if (content.includes(value)) {
            failures++;
            console.error(`FAIL  ${rel} contains the actual value of ${key}`);
        }
    }
}

if (failures > 0) {
    console.error(`\n${failures} finding(s) in build output — DO NOT DEPLOY this dist.`);
    process.exit(1);
}
console.log(`Scanned ${files} built file(s): no secret markers or values found.`);
