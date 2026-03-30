import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import express from 'express';
import net from 'net';
import { readFileSync } from 'fs';
import pino from 'pino'
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  },
});

let config = JSON.parse(readFileSync('./config.json'));

const server = express();
server.use(express.json());
server.use(express.static('.'));

// ─── OpenDota API caching layer ─────────────────────────────────────────────
const OPENDOTA_BASE = 'https://api.opendota.com/api';
const LEAGUE_ID = 18388;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes - keeps us well under 3000 calls/day
const PLAYER_STATS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours for player stats
const SEASON_2_START_MS = new Date('2026-03-27T00:00:00Z').getTime(); // Season 2 start date

// ─── Steam API for live games ────────────────────────────────────────────────
const STEAM_API_KEY = config.STEAM_API_KEY || '';
const STEAM_API_BASE = 'https://api.steampowered.com';
const LIVE_GAME_CACHE_TTL = 3000; // 3 seconds cache for live games

let matchCache = { data: null, lastFetched: 0 };
let playerStatsCache = { data: null, lastFetched: 0 };
let isRefreshingStats = false; // Prevent concurrent refreshes
let liveGameCache = {
    data: null,
    lastFetched: 0,
    isActive: false,
    gameCount: 0
};

// ─── Dota 2 Hero & Item Constants (from OpenDota) ────────────────────────────
let dotaConstants = { heroes: {}, items: {}, lastFetched: 0 };
const CONSTANTS_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

async function fetchDotaConstants() {
    try {
        logger.info('[Constants] Fetching hero and item data from OpenDota...');
        const [heroesRes, itemsRes] = await Promise.all([
            fetch(`${OPENDOTA_BASE}/constants/heroes`),
            fetch(`${OPENDOTA_BASE}/constants/items`)
        ]);

        if (heroesRes.ok) {
            const heroes = await heroesRes.json();
            const heroMap = {};
            for (const [, hero] of Object.entries(heroes)) {
                const slug = hero.name.replace('npc_dota_hero_', '');
                heroMap[hero.id] = {
                    name: hero.localized_name,
                    img: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${slug}.png`
                };
            }
            dotaConstants.heroes = heroMap;
        }

        if (itemsRes.ok) {
            const items = await itemsRes.json();
            const itemMap = {};
            for (const [key, item] of Object.entries(items)) {
                if (item.id) {
                    itemMap[item.id] = {
                        name: item.dname || key,
                        img: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/${key}.png`
                    };
                }
            }
            dotaConstants.items = itemMap;
        }

        dotaConstants.lastFetched = Date.now();
        logger.info(`[Constants] Loaded ${Object.keys(dotaConstants.heroes).length} heroes, ${Object.keys(dotaConstants.items).length} items`);
    } catch (err) {
        logger.error('[Constants] Failed to fetch:', err.message);
    }
}

// Fetch constants on startup
fetchDotaConstants();
// Refresh daily
setInterval(fetchDotaConstants, CONSTANTS_TTL_MS);

// Initialize database connection early (before any functions that use it)
let db = new Database('allUsers.db');

// Migrate schema: add columns and tables introduced after initial release
const columnMigrations = [
    'ALTER TABLE player_stats ADD COLUMN observer_kills INTEGER DEFAULT 0',
    'ALTER TABLE player_stats ADD COLUMN obs_ward_time_total INTEGER DEFAULT 0',
    'ALTER TABLE player_stats ADD COLUMN obs_ward_count INTEGER DEFAULT 0',
];
for (const sql of columnMigrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// Ensure match_mvps table exists with composite key (match_id, award_type)
{
    const cols = db.pragma('table_info(match_mvps)');
    const hasAwardType = cols.some(c => c.name === 'award_type');
    if (cols.length > 0 && !hasAwardType) {
        // Old schema (single PK) — drop and recreate with composite key
        logger.info('Migrating match_mvps table to composite key schema');
        db.exec('DROP TABLE match_mvps');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS match_mvps (
        match_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        award_type TEXT NOT NULL DEFAULT 'mvp',
        mvp_score REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (match_id, award_type)
    )`);
}

async function fetchOpenDota(path) {
    const res = await fetch(`${OPENDOTA_BASE}${path}`);
    if (!res.ok) throw new Error(`OpenDota API ${res.status}: ${path}`);
    // Log rate-limit headers when present
    const remaining = res.headers.get('x-rate-limit-remaining')
        || res.headers.get('x-ratelimit-remaining');
    if (remaining != null) {
        logger.info(`OpenDota rate limit remaining: ${remaining}`);
    }
    return res.json();
}

// ─── Database helpers for player stats ────────────────────────────────────
function loadPlayerStatsFromDB() {
    try {
        const query = `
            SELECT ps.account_id, ps.personaname, ps.wins, ps.losses, ps.kills,
                   ps.deaths, ps.assists, ps.gold_per_minute, ps.total_gold,
                   ps.wards_placed, ps.observer_kills, ps.obs_ward_time_total, ps.obs_ward_count,
                   ps.matches, ps.last_updated,
                   pa.avatar_url,
                   COALESCE(mv.mvp_count, 0) AS mvp_count,
                   COALESCE(sv.svp_count, 0) AS svp_count
            FROM player_stats ps
            LEFT JOIN player_avatars pa ON ps.account_id = pa.account_id
            LEFT JOIN (SELECT account_id, COUNT(*) AS mvp_count FROM match_mvps WHERE award_type = 'mvp' GROUP BY account_id) mv
                ON ps.account_id = mv.account_id
            LEFT JOIN (SELECT account_id, COUNT(*) AS svp_count FROM match_mvps WHERE award_type = 'svp' GROUP BY account_id) sv
                ON ps.account_id = sv.account_id
            WHERE ps.last_updated >= ?
        `;

        // better-sqlite3 has synchronous methods — only load Season 2 data
        const rows = db.prepare(query).all(SEASON_2_START_MS);

        const players = rows.map(row => ({
            accountId: row.account_id,
            name: row.personaname,
            avatar: row.avatar_url,
            wins: row.wins,
            losses: row.losses,
            matches: row.matches,
            winRate: row.matches > 0 ? (row.wins / row.matches) : 0,
            kills: row.kills,
            deaths: row.deaths,
            assists: row.assists,
            avgKills: row.matches > 0 ? (row.kills / row.matches) : 0,
            avgDeaths: row.matches > 0 ? (row.deaths / row.matches) : 0,
            avgAssists: row.matches > 0 ? (row.assists / row.matches) : 0,
            kda: row.deaths > 0 ? ((row.kills + row.assists) / row.deaths) : (row.kills + row.assists),
            gold_per_minute: row.gold_per_minute,
            avgGPM: row.matches > 0 ? (row.gold_per_minute / row.matches) : 0,
            total_gold: row.total_gold,
            avgNetWorth: row.matches > 0 ? (row.total_gold / row.matches) : 0,
            wards_placed: row.wards_placed,
            avgWards: row.matches > 0 ? (row.wards_placed / row.matches) : 0,
            observer_kills: row.observer_kills || 0,
            avgDewards: row.matches > 0 ? ((row.observer_kills || 0) / row.matches) : 0,
            avgObsWardDuration: (row.obs_ward_count || 0) > 0
                ? (row.obs_ward_time_total / row.obs_ward_count)
                : null,
            mvpCount: row.mvp_count || 0,
            svpCount: row.svp_count || 0,
        }));

        const oldestUpdate = rows.length > 0 ? Math.min(...rows.map(r => r.last_updated)) : 0;

        logger.info(`Loaded ${players.length} player stats from database`);
        return {
            players: players.filter(p => p.matches >= 3),
            lastFetched: oldestUpdate,
        };
    } catch (err) {
        logger.error(`Failed to load player stats from DB: ${err.message}`);
        return { players: [], lastFetched: 0 };
    }
}

function savePlayerStatsToDB(playerMap) {
    try {
        const now = Date.now();
        const insertStats = db.prepare(`
            INSERT OR REPLACE INTO player_stats
            (account_id, personaname, wins, losses, kills, deaths, assists, gold_per_minute, total_gold, wards_placed, observer_kills, obs_ward_time_total, obs_ward_count, matches, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const [accountId, stats] of playerMap.entries()) {
            insertStats.run(
                accountId,
                stats.name,
                stats.wins,
                stats.losses,
                stats.kills,
                stats.deaths,
                stats.assists,
                stats.gold_per_minute,
                stats.total_gold,
                stats.wards_placed,
                stats.observer_kills || 0,
                stats.obs_ward_time_total || 0,
                stats.obs_ward_count || 0,
                stats.matches,
                now
            );
        }

        logger.info(`Saved ${playerMap.size} player stats to database`);
    } catch (err) {
        logger.error(`Failed to save player stats to DB: ${err.message}`);
    }
}

async function fetchAndSaveAvatars(accountIds) {
    const insertAvatar = db.prepare(`
        INSERT OR REPLACE INTO player_avatars (account_id, avatar_url, last_updated)
        VALUES (?, ?, ?)
    `);

    const now = Date.now();
    let fetchedCount = 0;

    for (const accountId of accountIds) {
        try {
            // Check if we already have a recent avatar (within 7 days)
            const existing = db.prepare(
                'SELECT avatar_url, last_updated FROM player_avatars WHERE account_id = ?'
            ).get(accountId);

            if (existing && (now - existing.last_updated) < (7 * 24 * 60 * 60 * 1000)) {
                continue; // Skip if avatar is less than 7 days old
            }

            // Fetch player profile for avatar
            await new Promise(r => setTimeout(r, 2000)); // 2 second delay to avoid rate limits
            const profile = await fetchOpenDota(`/players/${accountId}`);

            if (profile && profile.profile) {
                const avatarUrl = profile.profile.avatarfull || profile.profile.avatar;
                if (avatarUrl) {
                    insertAvatar.run(accountId, avatarUrl, now);
                    fetchedCount++;
                }
            }
        } catch (err) {
            if (err.message.includes('429')) {
                logger.warn(`Rate limited while fetching avatar for ${accountId}, stopping avatar fetch`);
                break; // Stop fetching more avatars if rate limited
            }
            logger.error(`Failed to fetch avatar for ${accountId}: ${err.message}`);
        }
    }

    if (fetchedCount > 0) {
        logger.info(`Fetched and saved ${fetchedCount} new player avatars`);
    }
}

async function refreshMatchCache() {
    try {
        logger.info('Refreshing OpenDota match cache...');
        // Use /matchIds endpoint - /matches excludes amateur leagues like ours
        const matchIds = await fetchOpenDota(`/leagues/${LEAGUE_ID}/matchIds`);

        // Take the 10 most recent match IDs (API returns newest first)
        const recent = matchIds.slice(0, 10);

        // Fetch detailed data for each match (players, scores, winner)
        const detailed = [];
        for (const matchId of recent) {
            try {
                // Small delay between requests to stay under 60/min rate limit
                if (detailed.length > 0) await new Promise(r => setTimeout(r, 1100));
                const detail = await fetchOpenDota(`/matches/${matchId}`);
                // Load avatars from database for match players
                const getAvatar = db.prepare('SELECT avatar_url FROM player_avatars WHERE account_id = ?');
                const matchPlayers = (detail.players || []).map(p => {
                    let avatar = null;
                    if (p.account_id) {
                        const avatarRow = getAvatar.get(p.account_id);
                        avatar = avatarRow ? avatarRow.avatar_url : null;
                    }

                    const isRadiant = p.player_slot < 128;
                    // DPC-style fantasy score for MVP calculation
                    const mvpScore =
                        (p.kills || 0) * 0.5 +
                        (3 - (p.deaths || 0) * 0.3) +
                        (p.assists || 0) * 0.25 +
                        (p.last_hits || 0) * 0.004 +
                        (p.gold_per_min || 0) * 0.004 +
                        (p.hero_damage || 0) * 0.0002 +
                        (p.tower_damage || 0) * 0.0004 +
                        (p.hero_healing || 0) * 0.0002 +
                        (p.obs_placed || 0) * 0.5 +
                        (p.observer_kills || 0) * 0.5;

                    return {
                        account_id: p.account_id,
                        personaname: p.personaname || 'Anonymous',
                        player_slot: p.player_slot,
                        isRadiant,
                        kills: p.kills,
                        deaths: p.deaths,
                        assists: p.assists,
                        avatar: avatar,
                        mvpScore,
                    };
                });

                // MVP = highest score on winning team, SVP = highest score on losing team
                const winningTeamRadiant = detail.radiant_win;
                let mvpSlot = null;
                let mvpBest = -Infinity;
                let svpSlot = null;
                let svpBest = -Infinity;
                for (const p of matchPlayers) {
                    if (p.isRadiant === winningTeamRadiant) {
                        if (p.mvpScore > mvpBest) { mvpBest = p.mvpScore; mvpSlot = p.player_slot; }
                    } else {
                        if (p.mvpScore > svpBest) { svpBest = p.mvpScore; svpSlot = p.player_slot; }
                    }
                }
                for (const p of matchPlayers) {
                    p.isMVP = p.player_slot === mvpSlot;
                    p.isSVP = p.player_slot === svpSlot;
                }

                detailed.push({
                    match_id: detail.match_id,
                    radiant_win: detail.radiant_win,
                    radiant_score: detail.radiant_score,
                    dire_score: detail.dire_score,
                    duration: detail.duration,
                    start_time: detail.start_time,
                    game_mode: detail.game_mode,
                    players: matchPlayers,
                });
            } catch (err) {
                logger.error(`Failed to fetch match ${matchId}: ${err.message}`);
            }
        }

        matchCache = { data: detailed, lastFetched: Date.now() };
        logger.info(`Match cache refreshed: ${detailed.length} matches loaded`);
    } catch (err) {
        logger.error(`Failed to refresh match cache: ${err.message}`);
    }
}

async function refreshPlayerStats() {
    // Prevent concurrent refreshes
    if (isRefreshingStats) {
        logger.info('Player stats refresh already in progress, skipping');
        return;
    }

    isRefreshingStats = true;

    try {
        logger.info('Refreshing player statistics...');
        const matchIds = await fetchOpenDota(`/leagues/${LEAGUE_ID}/matchIds`);

        // Season 2 starts from this match onward — fetch all Season 2 matches
        const SEASON_2_FIRST_MATCH = 8745386473;
        const matchesToFetch = matchIds.filter(id => id >= SEASON_2_FIRST_MATCH);
        logger.info(`Fetching ${matchesToFetch.length} Season 2 matches for player statistics...`);

        const playerMap = new Map(); // accountId -> { name, wins, losses, kills, deaths, assists, matches }

        for (let i = 0; i < matchesToFetch.length; i++) {
            const matchId = matchesToFetch[i];
            try {
                // Delay to respect OpenDota's 60/min rate limit (~55 calls/min)
                if (i > 0) await new Promise(r => setTimeout(r, 1100));

                const detail = await fetchOpenDota(`/matches/${matchId}`);

                // Process each player in the match
                for (const player of detail.players || []) {
                    const accountId = player.account_id;
                    if (!accountId) continue; // Skip anonymous players

                    const isRadiant = player.player_slot < 128;
                    const won = detail.radiant_win === isRadiant;

                    if (!playerMap.has(accountId)) {
                        playerMap.set(accountId, {
                            name: player.personaname || 'Anonymous',
                            wins: 0,
                            losses: 0,
                            kills: 0,
                            deaths: 0,
                            assists: 0,
                            gold_per_minute: 0,
                            total_gold: 0,
                            wards_placed: 0,
                            observer_kills: 0,
                            obs_ward_time_total: 0,
                            obs_ward_count: 0,
                            matches: 0,
                        });
                    }

                    const stats = playerMap.get(accountId);
                    // Update name to most recent one (in case it changed)
                    if (player.personaname) {
                        stats.name = player.personaname;
                    }
                    stats.matches++;
                    if (won) stats.wins++;
                    else stats.losses++;
                    stats.kills += player.kills || 0;
                    stats.deaths += player.deaths || 0;
                    stats.assists += player.assists || 0;
                    stats.gold_per_minute += player.gold_per_min || 0;
                    // Total gold is gold remaining + gold spent
                    const totalGold = (player.gold || 0) + (player.gold_spent || 0);
                    stats.total_gold += totalGold;
                    // Wards placed (observer + sentry)
                    const wardsPlaced = (player.obs_placed || 0) + (player.sen_placed || 0);
                    stats.wards_placed += wardsPlaced;
                    // Dewards (enemy observer wards destroyed)
                    stats.observer_kills += player.observer_kills || 0;
                    // Observer ward durations (from parsed replay logs)
                    if (Array.isArray(player.obs_log) && Array.isArray(player.obs_left_log)) {
                        const leftByHandle = new Map();
                        for (const evt of player.obs_left_log) {
                            if (evt.ehandle != null) leftByHandle.set(evt.ehandle, evt.time);
                        }
                        for (const evt of player.obs_log) {
                            const leftTime = evt.ehandle != null ? leftByHandle.get(evt.ehandle) : undefined;
                            if (leftTime != null && evt.time != null) {
                                stats.obs_ward_time_total += (leftTime - evt.time);
                                stats.obs_ward_count++;
                            }
                        }
                    }
                }

                // Determine match MVP (winning team) and SVP (losing team)
                const winningRadiant = detail.radiant_win;
                let mvpId = null, mvpBest = -Infinity;
                let svpId = null, svpBest = -Infinity;

                // Track API fantasy points for comparison
                let mvpIdAPI = null, mvpBestAPI = -Infinity;
                let svpIdAPI = null, svpBestAPI = -Infinity;
                const debugPlayers = [];

                for (const p of detail.players || []) {
                    if (!p.account_id) continue;
                    const pRadiant = p.player_slot < 128;

                    // Our manual calculation
                    const score =
                        (p.kills || 0) * 0.5 +
                        (3 - (p.deaths || 0) * 0.3) +
                        (p.assists || 0) * 0.25 +
                        (p.last_hits || 0) * 0.004 +
                        (p.gold_per_min || 0) * 0.004 +
                        (p.hero_damage || 0) * 0.0002 +
                        (p.tower_damage || 0) * 0.0004 +
                        (p.hero_healing || 0) * 0.0002 +
                        (p.obs_placed || 0) * 0.5 +
                        (p.observer_kills || 0) * 0.5;

                    // Check if API provides fantasy_points
                    const apiScore = p.fantasy_points || null;

                    debugPlayers.push({
                        name: p.personaname || 'Anonymous',
                        isRadiant: pRadiant,
                        manualScore: score.toFixed(2),
                        apiScore: apiScore != null ? apiScore.toFixed(2) : 'N/A',
                    });

                    // Manual MVP/SVP selection
                    if (pRadiant === winningRadiant) {
                        if (score > mvpBest) { mvpBest = score; mvpId = p.account_id; }
                    } else {
                        if (score > svpBest) { svpBest = score; svpId = p.account_id; }
                    }

                    // API-based MVP/SVP selection (if available)
                    if (apiScore != null) {
                        if (pRadiant === winningRadiant) {
                            if (apiScore > mvpBestAPI) { mvpBestAPI = apiScore; mvpIdAPI = p.account_id; }
                        } else {
                            if (apiScore > svpBestAPI) { svpBestAPI = apiScore; svpIdAPI = p.account_id; }
                        }
                    }
                }

                // Debug logging for first match only to avoid spam
                if (i === 0) {
                    logger.info(`=== MVP/SVP Comparison for Match ${matchId} ===`);
                    logger.info(`Player Scores:`);
                    debugPlayers.forEach(p => {
                        logger.info(`  ${p.name} (${p.isRadiant ? 'Radiant' : 'Dire'}): Manual=${p.manualScore}, API=${p.apiScore}`);
                    });
                    const mvpPlayer = detail.players.find(p => p.account_id === mvpId);
                    const svpPlayer = detail.players.find(p => p.account_id === svpId);
                    logger.info(`Manual MVP: ${mvpPlayer?.personaname || 'Unknown'} (${mvpBest.toFixed(2)})`);
                    logger.info(`Manual SVP: ${svpPlayer?.personaname || 'Unknown'} (${svpBest.toFixed(2)})`);
                    if (mvpIdAPI) {
                        const mvpPlayerAPI = detail.players.find(p => p.account_id === mvpIdAPI);
                        const svpPlayerAPI = detail.players.find(p => p.account_id === svpIdAPI);
                        logger.info(`API MVP: ${mvpPlayerAPI?.personaname || 'Unknown'} (${mvpBestAPI.toFixed(2)})`);
                        logger.info(`API SVP: ${svpPlayerAPI?.personaname || 'Unknown'} (${svpBestAPI.toFixed(2)})`);
                        logger.info(`MVP Match: ${mvpId === mvpIdAPI ? 'YES' : 'NO'}`);
                        logger.info(`SVP Match: ${svpId === svpIdAPI ? 'YES' : 'NO'}`);
                    } else {
                        logger.info(`API fantasy_points not available in match data`);
                    }
                    logger.info(`=== End Comparison ===`);
                }
                const insertAward = db.prepare(
                    'INSERT OR IGNORE INTO match_mvps (match_id, account_id, award_type, mvp_score, created_at) VALUES (?, ?, ?, ?, ?)'
                );
                const now = Date.now();
                if (mvpId != null) {
                    try { insertAward.run(matchId, mvpId, 'mvp', mvpBest, now); } catch (_) {}
                }
                if (svpId != null) {
                    try { insertAward.run(matchId, svpId, 'svp', svpBest, now); } catch (_) {}
                }

                if ((i + 1) % 10 === 0) {
                    logger.info(`Progress: ${i + 1}/${matchesToFetch.length} matches processed`);
                }
            } catch (err) {
                if (err.message.includes('429')) {
                    logger.error(`Rate limited at match ${i + 1}/${matchesToFetch.length}, stopping refresh`);
                    break; // Stop if rate limited
                }
                logger.error(`Failed to fetch match ${matchId} for stats: ${err.message}`);
            }
        }

        // Save to database
        savePlayerStatsToDB(playerMap);

        // Fetch avatars for players (with rate limiting and caching)
        const accountIds = Array.from(playerMap.keys());
        await fetchAndSaveAvatars(accountIds);

        // Load avatars and MVP counts from DB and merge with player stats
        const avatarQuery = db.prepare('SELECT account_id, avatar_url FROM player_avatars');
        const avatars = new Map(avatarQuery.all().map(row => [row.account_id, row.avatar_url]));
        const mvpQuery = db.prepare("SELECT account_id, COUNT(*) AS cnt FROM match_mvps WHERE award_type = 'mvp' AND match_id >= ? GROUP BY account_id");
        const mvpCounts = new Map(mvpQuery.all(SEASON_2_FIRST_MATCH).map(row => [row.account_id, row.cnt]));
        const svpQuery = db.prepare("SELECT account_id, COUNT(*) AS cnt FROM match_mvps WHERE award_type = 'svp' AND match_id >= ? GROUP BY account_id");
        const svpCounts = new Map(svpQuery.all(SEASON_2_FIRST_MATCH).map(row => [row.account_id, row.cnt]));

        // Convert to array and calculate derived stats
        const players = Array.from(playerMap.entries()).map(([accountId, stats]) => ({
            accountId,
            name: stats.name,
            avatar: avatars.get(accountId) || null,
            wins: stats.wins,
            losses: stats.losses,
            matches: stats.matches,
            winRate: stats.matches > 0 ? (stats.wins / stats.matches) : 0,
            kills: stats.kills,
            deaths: stats.deaths,
            assists: stats.assists,
            avgKills: stats.matches > 0 ? (stats.kills / stats.matches) : 0,
            avgDeaths: stats.matches > 0 ? (stats.deaths / stats.matches) : 0,
            avgAssists: stats.matches > 0 ? (stats.assists / stats.matches) : 0,
            kda: stats.deaths > 0 ? ((stats.kills + stats.assists) / stats.deaths) : (stats.kills + stats.assists),
            gold_per_minute: stats.gold_per_minute,
            avgGPM: stats.matches > 0 ? (stats.gold_per_minute / stats.matches) : 0,
            total_gold: stats.total_gold,
            avgNetWorth: stats.matches > 0 ? (stats.total_gold / stats.matches) : 0,
            wards_placed: stats.wards_placed,
            avgWards: stats.matches > 0 ? (stats.wards_placed / stats.matches) : 0,
            observer_kills: stats.observer_kills || 0,
            avgDewards: stats.matches > 0 ? ((stats.observer_kills || 0) / stats.matches) : 0,
            avgObsWardDuration: (stats.obs_ward_count || 0) > 0
                ? (stats.obs_ward_time_total / stats.obs_ward_count)
                : null,
            mvpCount: mvpCounts.get(accountId) || 0,
            svpCount: svpCounts.get(accountId) || 0,
        }));

        // Filter out players with very few matches
        const qualifiedPlayers = players.filter(p => p.matches >= 3);

        playerStatsCache = {
            data: qualifiedPlayers,
            lastFetched: Date.now(),
            matchesAnalyzed: matchesToFetch.length,
        };

        logger.info(`Player stats refreshed: ${qualifiedPlayers.length} players tracked from ${matchesToFetch.length} matches`);
    } catch (err) {
        logger.error(`Failed to refresh player stats: ${err.message}`);
    } finally {
        isRefreshingStats = false;
    }
}

// Initial fetch on startup (await to ensure cache is ready before serving)
await refreshMatchCache();

// Set up periodic background refresh every 10 minutes
setInterval(() => {
    refreshMatchCache();
}, CACHE_TTL_MS);

// Load Season 2 player stats from database on startup (filtered by SEASON_2_START_MS)
const dbStats = loadPlayerStatsFromDB();
if (dbStats.players.length > 0) {
    playerStatsCache = {
        data: dbStats.players,
        lastFetched: dbStats.lastFetched,
        matchesAnalyzed: dbStats.players.length > 0 ? dbStats.players[0].matches : 0,
    };
    logger.info(`Loaded ${dbStats.players.length} Season 2 player stats from database, last updated ${new Date(dbStats.lastFetched).toISOString()}`);
}

// Refresh player stats if cache is stale (older than 12 hours) or empty
if (Date.now() - dbStats.lastFetched > PLAYER_STATS_TTL_MS || dbStats.players.length === 0) {
    logger.info('Player stats cache is stale or empty, refreshing in background');
    refreshPlayerStats(); // Don't await - run in background
} else {
    logger.info('Player stats cache is fresh, skipping initial refresh');

    // Check if we need to fetch missing avatars
    const playersWithoutAvatars = dbStats.players.filter(p => !p.avatar);
    if (playersWithoutAvatars.length > 0) {
        logger.info(`Found ${playersWithoutAvatars.length} players without avatars, fetching in background`);
        const accountIds = playersWithoutAvatars.map(p => p.accountId);
        fetchAndSaveAvatars(accountIds).then(() => {
            // Reload player stats after avatar fetch to update cache
            const updatedStats = loadPlayerStatsFromDB();
            if (updatedStats.players.length > 0) {
                playerStatsCache.data = updatedStats.players;
                logger.info('Player stats cache updated with new avatars');
            }
            return refreshMatchCache();
        }).then(() => {
            logger.info('Match cache refreshed with new avatars');
        }).catch(err => {
            logger.error(`Failed to fetch missing avatars: ${err.message}`);
        });
    }
}

// Set up periodic player stats refresh every 12 hours
setInterval(() => {
    refreshPlayerStats();
}, PLAYER_STATS_TTL_MS);

// ─── Steam API: Fetch Live Game ──────────────────────────────────────────────
async function fetchLiveGame() {
    const startTime = Date.now();
    logger.info('[LiveGame] Starting Steam API fetch...');

    try {
        const url = `${STEAM_API_BASE}/IDOTA2Match_570/GetLiveLeagueGames/v0001/?key=${STEAM_API_KEY}&league_id=${LEAGUE_ID}`;
        logger.info('[LiveGame] Fetching from Steam API...');

        const response = await fetch(url, { timeout: 10000 });
        const elapsed = Date.now() - startTime;
        logger.info(`[LiveGame] Steam API responded in ${elapsed}ms with status ${response.status}`);

        if (!response.ok) {
            logger.error(`[LiveGame] Steam API error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const games = data?.result?.games || [];
        logger.info(`[LiveGame] Found ${games.length} total live games across ALL leagues`);

        // Log all league IDs for debugging (helps identify if our game appears under a different ID)
        if (games.length > 0) {
            const leagueIds = [...new Set(games.map(g => g.league_id))];
            logger.info(`[LiveGame] League IDs in response: ${JSON.stringify(leagueIds)}`);
        }

        // Filter to our league only — return ALL matching games
        const ourGames = games.filter(g => g.league_id === LEAGUE_ID);
        logger.info(`[LiveGame] Looking for league_id=${LEAGUE_ID}, found ${ourGames.length} game(s)`);

        ourGames.forEach((game, i) => {
            logger.info(`[LiveGame] Game ${i + 1}: match_id=${game.match_id}, has scoreboard=${!!game.scoreboard}`);
            if (game.scoreboard) {
                logger.info(`[LiveGame] Game ${i + 1} scoreboard: duration=${game.scoreboard.duration}, radiant=${!!game.scoreboard.radiant}, dire=${!!game.scoreboard.dire}`);
            }
        });

        return ourGames;
    } catch (error) {
        const elapsed = Date.now() - startTime;
        logger.error(`[LiveGame] Failed after ${elapsed}ms:`, error.message || error);
        return [];
    }
}

// Serve static files from node_modules
server.use('/node_modules', express.static('node_modules'));

// Optional: Add CORS if needed for browsers
server.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');  // Allow all for testing
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

server.get('/', (request, response) => {
    logger.info('GET: ' + request.url);
    logger.info('------------------------------------------');
    return response.sendFile('index.html', { root: '.' });
});

server.get('/about', (req, res) => {
    return res.sendFile('about.html', { root: '.' });
});

server.get('/matches', (req, res) => {
    return res.sendFile('matches.html', { root: '.' });
});

server.get('/rankings', (req, res) => {
    return res.sendFile('rankings.html', { root: '.' });
});

server.get('/livegame', (req, res) => {
    return res.sendFile('livegame.html', { root: '.' });
});

server.get('/api/live-game', async (req, res) => {
    const requestStart = Date.now();
    logger.info('[API /api/live-game] Request received');

    // Helper: resolve item ID to { name, img } or null
    function resolveItem(id) {
        if (!id || id === 0) return null;
        const item = dotaConstants.items[id];
        return item ? { id, name: item.name, img: item.img } : { id, name: 'Unknown', img: null };
    }

    // Helper: transform a single raw game into frontend format
    function transformGameData(game) {
        const radiantPlayerList = game.scoreboard.radiant.players || [];
        const direPlayerList = game.scoreboard.dire.players || [];

        function transformPlayer(p, team) {
            const playerInfo = (game.players || []).find(pl => pl.account_id === p.account_id);
            const hero = dotaConstants.heroes[playerInfo?.hero_id];
            return {
                accountId: p.account_id,
                name: playerInfo?.name || 'Unknown',
                heroId: playerInfo?.hero_id,
                heroName: hero?.name || null,
                heroImg: hero?.img || null,
                team,
                kills: p.kills || 0,
                deaths: p.death || 0,
                assists: p.assists || 0,
                lastHits: p.last_hits || 0,
                denies: p.denies || 0,
                gpm: p.gold_per_min || 0,
                xpm: p.xp_per_min || 0,
                netWorth: p.net_worth || 0,
                level: p.level || 1,
                items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map(resolveItem),
                posX: p.position_x,
                posY: p.position_y,
                respawnTimer: p.respawn_timer || 0
            };
        }

        return {
            matchId: game.match_id,
            duration: game.scoreboard.duration || 0,
            spectators: game.spectators || 0,
            radiant: {
                score: game.scoreboard.radiant.score || 0,
                towerState: game.scoreboard.radiant.tower_state || 0,
                barracksState: game.scoreboard.radiant.barracks_state || 0,
                players: radiantPlayerList.map(p => transformPlayer(p, 'radiant'))
            },
            dire: {
                score: game.scoreboard.dire.score || 0,
                towerState: game.scoreboard.dire.tower_state || 0,
                barracksState: game.scoreboard.dire.barracks_state || 0,
                players: direPlayerList.map(p => transformPlayer(p, 'dire'))
            }
        };
    }

    try {
        const now = Date.now();

        // Return cached data if still fresh
        if (liveGameCache.data && (now - liveGameCache.lastFetched) < LIVE_GAME_CACHE_TTL) {
            logger.info('[API /api/live-game] Returning cached data');
            return res.json(liveGameCache.data);
        }

        logger.info('[API /api/live-game] Cache miss, fetching fresh data...');
        const rawGames = await fetchLiveGame();
        liveGameCache.lastFetched = Date.now();
        liveGameCache.isActive = rawGames.length > 0;
        liveGameCache.gameCount = rawGames.length;

        if (rawGames.length === 0) {
            logger.info('[API /api/live-game] No games found, returning inactive');
            liveGameCache.data = { active: false, gameCount: 0, games: [], pendingGames: [] };
            return res.json(liveGameCache.data);
        }

        const transformedGames = [];
        const pendingGames = [];

        for (const game of rawGames) {
            // Defensive checks for game structure
            if (!game.scoreboard || !game.scoreboard.radiant || !game.scoreboard.dire) {
                logger.warn(`[API /api/live-game] Game match_id=${game.match_id} missing scoreboard data (picking phase?)`);
                pendingGames.push({ pending: true, matchId: game.match_id });
                continue;
            }

            const radiantPlayerList = game.scoreboard.radiant.players || [];
            const direPlayerList = game.scoreboard.dire.players || [];
            logger.info(`[API /api/live-game] Processing game match_id=${game.match_id}: ${radiantPlayerList.length} radiant, ${direPlayerList.length} dire players`);

            transformedGames.push(transformGameData(game));
        }

        logger.info(`[API /api/live-game] Transformed ${transformedGames.length} active game(s), ${pendingGames.length} pending game(s)`);

        liveGameCache.data = {
            active: transformedGames.length > 0,
            gameCount: transformedGames.length,
            games: transformedGames,
            pendingGames: pendingGames
        };

        const elapsed = Date.now() - requestStart;
        logger.info(`[API /api/live-game] Success, responding in ${elapsed}ms`);
        return res.json(liveGameCache.data);

    } catch (error) {
        const elapsed = Date.now() - requestStart;
        logger.error(`[API /api/live-game] ERROR after ${elapsed}ms:`, error.message || error);
        logger.error('[API /api/live-game] Stack:', error.stack);
        // Return inactive rather than crashing
        return res.json({ active: false, gameCount: 0, games: [], pendingGames: [], error: 'server_error' });
    }
});

server.get('/api/live-game/status', async (req, res) => {
    try {
        const now = Date.now();

        // Use cached status if recent
        if ((now - liveGameCache.lastFetched) < LIVE_GAME_CACHE_TTL) {
            return res.json({ active: liveGameCache.isActive, gameCount: liveGameCache.gameCount || 0 });
        }

        logger.info('[API /api/live-game/status] Cache miss, checking Steam API...');
        const games = await fetchLiveGame();
        liveGameCache.isActive = games.length > 0;
        liveGameCache.gameCount = games.length;
        liveGameCache.lastFetched = now;

        return res.json({ active: games.length > 0, gameCount: games.length });
    } catch (error) {
        logger.error('[API /api/live-game/status] ERROR:', error.message || error);
        return res.json({ active: false, gameCount: 0, error: 'server_error' });
    }
});

server.get('/api/recent-matches', async (req, res) => {
    // Refresh cache if stale
    if (Date.now() - matchCache.lastFetched > CACHE_TTL_MS) {
        await refreshMatchCache();
    }
    // Filter out debug matches (less than 10 players)
    const fullMatches = (matchCache.data || []).filter(match => {
        const playerCount = match.players?.length || 0;
        return playerCount >= 10;
    });
    return res.json({
        matches: fullMatches,
        lastUpdated: matchCache.lastFetched,
        cacheMaxAge: CACHE_TTL_MS,
    });
});

server.get('/api/top-rankings', async (req, res) => {
    // Don't refresh if already refreshing
    if (!isRefreshingStats && Date.now() - playerStatsCache.lastFetched > PLAYER_STATS_TTL_MS) {
        // Trigger refresh in background, don't wait for it
        refreshPlayerStats();
    }

    const players = playerStatsCache.data || [];

    // TODO: Re-enable minimum match threshold once Season 2 has more games (e.g. Math.max(10, ...))
    const minMatches = 0;
    const qualified = players;

    // Top 10 by win rate
    const topByWinRate = [...qualified]
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 10);

    // Top 10 by K/D/A
    const topByKDA = [...qualified]
        .sort((a, b) => b.kda - a.kda)
        .slice(0, 10);

    // Top 10 by GPM
    const topByGPM = [...qualified]
        .sort((a, b) => b.avgGPM - a.avgGPM)
        .slice(0, 10);

    // Top 10 by wards placed
    const topByWards = [...qualified]
        .sort((a, b) => b.avgWards - a.avgWards)
        .slice(0, 10);

    // Top 10 dewarders (by avg observer wards killed per game)
    const topByDewards = [...qualified]
        .filter(p => p.observer_kills > 0)
        .sort((a, b) => b.avgDewards - a.avgDewards)
        .slice(0, 10);

    // "Hand of Midas, Heart of Absence" - highest net worth per fight participation.
    // Score = avgNetWorth / (avgKills + avgAssists + 1)
    // The +1 prevents division by zero and slightly penalises zero participation.
    const topByMidas = [...qualified]
        .map(p => ({
            ...p,
            midasScore: p.avgNetWorth / (p.avgKills + p.avgAssists + 1),
        }))
        .sort((a, b) => b.midasScore - a.midasScore)
        .slice(0, 10);

    // Player of the Month — most MVP awards (no minimum-match filter; MVPs already require wins)
    const playerOfTheMonth = [...players]
        .filter(p => p.mvpCount > 0)
        .sort((a, b) => b.mvpCount - a.mvpCount || b.svpCount - a.svpCount)
        .slice(0, 1)[0] || null;

    return res.json({
        topByWinRate,
        topByKDA,
        topByGPM,
        topByWards,
        topByDewards,
        topByMidas,
        playerOfTheMonth,
        minMatchesRequired: minMatches,
        lastUpdated: playerStatsCache.lastFetched,
        matchesAnalyzed: playerStatsCache.matchesAnalyzed || 0,
        cacheMaxAge: PLAYER_STATS_TTL_MS,
    });
});

server.put('/', async (req, res) => {
    logger.info('PUT: ' + JSON.stringify(req.body));
    logger.info('------------------------------------------');

    const { tokenType, accessToken, rank } = req.body;

    if (!tokenType || !accessToken) {
        logger.error("Returning 400: Either missing tokentype or accesstoken.  tokenType: ${tokenType}  accessToken: ${accessToken}")
        return res.status(400).json({ result: 'Missing token information' });
    }

    if (!rank) {
        logger.error("Returning 400: Missing rank selection");
        return res.status(400).json({ result: 'Please select your Dota 2 rank' });
    }

    try {
        logger.info("Fetching userId and Connections")
        const [userRes, connRes] = await Promise.all([
            fetch('https://discord.com/api/users/@me', {
                headers: { authorization: `${tokenType} ${accessToken}` },
            }),
            fetch('https://discord.com/api/users/@me/connections', {
                headers: { authorization: `${tokenType} ${accessToken}` },
            }),
        ]);

        const user = await userRes.json();
        const connections = await connRes.json();

        if (!user.id) {
            logger.error('Returning 400: No User ID found. ID: ${user.id}');
            return res.status(400).json({ result: 'Invalid Discord credentials. Please try again.' });
        }

        const discordID = user.id;
        let steamID = null;
        let steamName = null;

        for (const conn of connections) {
            if (conn.type === 'steam') {
                steamID = conn.id;
                steamName = conn.name;
                break;
            }
        }

        if (!steamID) {
            logger.error("Returning 400: No Steam ID Linked")
            return res.status(400).json({ result: 'No Steam ID linked to Discord. Please link under \'Connections\' in Discord Settings and Try Again.' });
        }

        // Convert rank to rating
        const rankToRating = {
            'Rusty': 250,
            'Herald': 500,
            'Guardian': 1200,
            'Crusader': 1800,
            'Archon': 2600,
            'Legend': 3300,
            'Ancient': 4100,
            'Divine': 5000,
            'Immortal': 5500
        };
        
        const rating = rankToRating[rank] || 3000; // Default to 3000 if rank not found
        logger.info(`Converting rank '${rank}' to rating ${rating} for user ${discordID}`);

        // Insert user into database with rating
        try {
            const stmt = db.prepare(`
                INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched, rating)
                VALUES (?, ?, datetime('now'), ?, 0, ?)
                ON CONFLICT(discord_id) DO UPDATE SET
                    steam_id = excluded.steam_id,
                    rating = excluded.rating
            `);
            stmt.run(discordID, steamID, config.MOD_ASSIGNMENT, rating);
        } catch (err) {
            logger.error('DB upsert error:', err.message);
        }

        //Notify local pipe
        try {
            const socketPipe = new net.Socket();
            socketPipe.on('error', err => {
                logger.error('Pipe connection error:', err);
            });
            socketPipe.connect(config.pipePort, '127.0.0.1', function () {
                socketPipe.write(`${discordID}`);
                socketPipe.end();
            });
        } catch (pipeErr) {
            logger.error('Pipe error:', pipeErr);
        }

        // Add member to guild
        try {
            logger.info(
              {
                guildUrl: `https://discord.com/api/guilds/${config.GUILD_ID}/members/${discordID}`,
                discordID,
                guildID: config.GUILD_ID,
              },
              'Attempting to add user to guild'
            );
            const guildRes = await fetch(`https://discord.com/api/guilds/${config.GUILD_ID}/members/${discordID}`, {
                method: 'PUT',
                body: JSON.stringify({ access_token: accessToken }),
                headers: {
                    'Authorization': `Bot ${config.BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!guildRes.ok && guildRes.status !== 204) {
                const errText = await guildRes.text();
                logger.error(`Failed to add user to guild: ${guildRes.status} ${errText}`);
                return res.status(400).json({
                    result: `Failed to join guild: ${guildRes.status} - ${errText}`
                });
            }

            logger.info(`Successfully added ${discordID} to guild.`);
            return res.status(201).json({ result: steamName });

        } catch (err) {
            logger.error('Guild add error:', err);
            return res.status(500).json({ result: 'Error adding user to guild' });
        }

        logger.info(`Registered: ${discordID} with Steam ${steamName} (${steamID})`);
        return res.status(201).json({ result: steamName });
    } catch (err) {
        logger.error('Unhandled server error:', err);
        return res.status(500).json({ result: 'Server error occurred' });
    }
});

// ─── Global Error Handlers ───────────────────────────────────────────────────
process.on('uncaughtException', (error) => {
    logger.error('[FATAL] Uncaught Exception:', error.message);
    logger.error('[FATAL] Stack:', error.stack);
    // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason) => {
    logger.error('[FATAL] Unhandled Promise Rejection:', reason);
    if (reason instanceof Error) {
        logger.error('[FATAL] Stack:', reason.stack);
    }
    // Don't exit - try to keep running
});

server.listen(3000, '0.0.0.0', () => logger.info(`Server listening at http://localhost:3000`));
