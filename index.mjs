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

let matchCache = { data: null, lastFetched: 0 };
let playerStatsCache = { data: null, lastFetched: 0 };
let isRefreshingStats = false; // Prevent concurrent refreshes

// Initialize database connection early (before any functions that use it)
let db = new Database('allUsers.db');

async function fetchOpenDota(path) {
    const res = await fetch(`${OPENDOTA_BASE}${path}`);
    if (!res.ok) throw new Error(`OpenDota API ${res.status}: ${path}`);
    return res.json();
}

// ─── Database helpers for player stats ────────────────────────────────────
function loadPlayerStatsFromDB() {
    try {
        const query = `
            SELECT ps.account_id, ps.personaname, ps.wins, ps.losses, ps.kills,
                   ps.deaths, ps.assists, ps.matches, ps.last_updated,
                   pa.avatar_url
            FROM player_stats ps
            LEFT JOIN player_avatars pa ON ps.account_id = pa.account_id
        `;

        // better-sqlite3 has synchronous methods
        const rows = db.prepare(query).all();

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
            (account_id, personaname, wins, losses, kills, deaths, assists, matches, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        // Use /matchIds endpoint — /matches excludes amateur leagues like ours
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

                    return {
                        personaname: p.personaname || 'Anonymous',
                        player_slot: p.player_slot,
                        isRadiant: p.player_slot < 128,
                        kills: p.kills,
                        deaths: p.deaths,
                        assists: p.assists,
                        avatar: avatar,
                    };
                });

                detailed.push({
                    match_id: detail.match_id,
                    radiant_win: detail.radiant_win,
                    radiant_score: detail.radiant_score,
                    dire_score: detail.dire_score,
                    duration: detail.duration,
                    start_time: detail.start_time,
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

        // Take up to 100 most recent matches for comprehensive stats
        const matchesToFetch = matchIds.slice(0, 100);
        logger.info(`Fetching ${matchesToFetch.length} matches for player statistics...`);

        const playerMap = new Map(); // accountId -> { name, wins, losses, kills, deaths, assists, matches }

        for (let i = 0; i < matchesToFetch.length; i++) {
            const matchId = matchesToFetch[i];
            try {
                // Delay to respect rate limits - 2 seconds between calls
                if (i > 0) await new Promise(r => setTimeout(r, 2000));

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

        // Load avatars from DB and merge with player stats
        const avatarQuery = db.prepare('SELECT account_id, avatar_url FROM player_avatars');
        const avatars = new Map(avatarQuery.all().map(row => [row.account_id, row.avatar_url]));

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

// Load player stats from database on startup
const dbStats = loadPlayerStatsFromDB();
if (dbStats.players.length > 0) {
    playerStatsCache = {
        data: dbStats.players,
        lastFetched: dbStats.lastFetched,
        matchesAnalyzed: 100, // Approximate
    };
    logger.info(`Loaded player stats from database, last updated ${new Date(dbStats.lastFetched).toISOString()}`);
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
        }).catch(err => {
            logger.error(`Failed to fetch missing avatars: ${err.message}`);
        });
    }
}

// Set up periodic player stats refresh every 12 hours
setInterval(() => {
    refreshPlayerStats();
}, PLAYER_STATS_TTL_MS);

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

server.get('/api/recent-matches', async (req, res) => {
    // Refresh cache if stale
    if (Date.now() - matchCache.lastFetched > CACHE_TTL_MS) {
        await refreshMatchCache();
    }
    return res.json({
        matches: matchCache.data || [],
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

    // Weighted scoring function: metric * (1 + log(games) / 10)
    // This gives more weight to players with more games played
    const calculateWeightedScore = (metric, games) => {
        if (games < 3) return 0;
        const gameWeight = 1 + (Math.log(games) / 10);
        return metric * gameWeight;
    };

    // Top 10 by win rate (weighted by number of games)
    const topByWinRate = [...players]
        .map(p => ({
            ...p,
            weightedScore: calculateWeightedScore(p.winRate, p.matches)
        }))
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 10);

    // Top 10 by K/D/A (weighted by number of games)
    const topByKDA = [...players]
        .map(p => ({
            ...p,
            weightedScore: calculateWeightedScore(p.kda, p.matches)
        }))
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 10);

    return res.json({
        topByWinRate,
        topByKDA,
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

server.listen(3000, '0.0.0.0', () => logger.info(`Server listening at http://localhost:3000`));
