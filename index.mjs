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

let matchCache = { data: null, lastFetched: 0 };

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

// Initial fetch on startup
refreshMatchCache();

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
