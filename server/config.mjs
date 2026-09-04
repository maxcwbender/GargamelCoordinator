import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

// Repo root (one level up from server/). All file paths resolve from here so the
// server behaves the same no matter what directory it's launched from.
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// config.json holds Discord/bot settings shared with the Python bot. It is
// gitignored and must NEVER be reachable from the web — see static.mjs.
export const config = JSON.parse(readFileSync(join(ROOT, 'config.json')));

// ─── OpenDota ────────────────────────────────────────────────────────────────
export const OPENDOTA_BASE = 'https://api.opendota.com/api';
export const LEAGUE_ID = 18388;
export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes - keeps us well under 3000 calls/day
export const PLAYER_STATS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours for player stats
export const CURRENT_SEASON = 2;
export const SEASON_2_FIRST_MATCH = 8745386473;
export const CONSTANTS_TTL_MS = 24 * 60 * 60 * 1000; // hero/item constants refresh daily

// ─── Steam / Discord ─────────────────────────────────────────────────────────
export const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const STEAM_API_BASE = 'https://api.steampowered.com';
export const LIVE_GAME_CACHE_TTL = 3000; // 3 seconds cache for live games
