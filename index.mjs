import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
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

async function fetchOpenDota(path) {
    const res = await fetch(`${OPENDOTA_BASE}${path}`);
    if (!res.ok) throw new Error(`OpenDota API ${res.status}: ${path}`);
    return res.json();
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
                detailed.push({
                    match_id: detail.match_id,
                    radiant_win: detail.radiant_win,
                    radiant_score: detail.radiant_score,
                    dire_score: detail.dire_score,
                    duration: detail.duration,
                    start_time: detail.start_time,
                    players: (detail.players || []).map(p => ({
                        personaname: p.personaname || 'Anonymous',
                        player_slot: p.player_slot,
                        isRadiant: p.player_slot < 128,
                        kills: p.kills,
                        deaths: p.deaths,
                        assists: p.assists,
                        avatar: p.avatarfull || p.avatar || null,
                    })),
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
                // Delay to respect 60/min rate limit (1 call per second = 60/min)
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
                            avatar: player.avatarfull || player.avatar || null,
                            wins: 0,
                            losses: 0,
                            kills: 0,
                            deaths: 0,
                            assists: 0,
                            matches: 0,
                        });
                    }

                    const stats = playerMap.get(accountId);
                    // Update avatar to most recent one (in case it changed)
                    if (player.avatarfull || player.avatar) {
                        stats.avatar = player.avatarfull || player.avatar;
                    }
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
                logger.error(`Failed to fetch match ${matchId} for stats: ${err.message}`);
            }
        }

        // Convert to array and calculate derived stats
        const players = Array.from(playerMap.entries()).map(([accountId, stats]) => ({
            accountId,
            name: stats.name,
            avatar: stats.avatar,
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
    }
}

// Initial fetch on startup (await to ensure cache is ready before serving)
await refreshMatchCache();

// Set up periodic background refresh every 10 minutes
setInterval(() => {
    refreshMatchCache();
}, CACHE_TTL_MS);

// Initial player stats fetch (don't await - can load in background)
refreshPlayerStats();

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

let db = new sqlite3.Database('allUsers.db');

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
    // Refresh cache if stale
    if (Date.now() - playerStatsCache.lastFetched > PLAYER_STATS_TTL_MS) {
        await refreshPlayerStats();
    }

    const players = playerStatsCache.data || [];

    // Top 10 by win rate (minimum 3 matches)
    const topByWinRate = [...players]
        .sort((a, b) => {
            // Sort by win rate first, then by total matches as tiebreaker
            if (Math.abs(b.winRate - a.winRate) < 0.001) {
                return b.matches - a.matches;
            }
            return b.winRate - a.winRate;
        })
        .slice(0, 10);

    // Top 10 by K/D/A
    const topByKDA = [...players]
        .sort((a, b) => {
            // Sort by KDA first, then by total matches as tiebreaker
            if (Math.abs(b.kda - a.kda) < 0.01) {
                return b.matches - a.matches;
            }
            return b.kda - a.kda;
        })
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
        const stmt = db.prepare(`
            INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched, rating) 
            VALUES (?, ?, datetime('now'), ?, 0, ?)
            ON CONFLICT(discord_id) DO UPDATE SET 
                steam_id = excluded.steam_id,
                rating = excluded.rating
        `);
        await new Promise((resolve, reject) => {
            stmt.run(discordID, steamID, config.MOD_ASSIGNMENT, rating, err => {
                if (err) logger.error('DB upsert error:', err.message);
                else resolve();
            });
        });
        stmt.finalize();

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
