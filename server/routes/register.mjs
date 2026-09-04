import fetch from 'node-fetch';
import net from 'net';
import { db } from '../db.mjs';
import { logger } from '../logger.mjs';
import { config, BOT_TOKEN } from '../config.mjs';
import { discordMembersCache, refreshDiscordMembers } from '../services/discord.mjs';

// Registration flow (Discord OAuth PUT /), member autocomplete, and the ntfy
// notification signup info endpoint.
export function mountRegisterRoutes(server) {
    server.get('/api/discord-members', async (req, res) => {
        // If cache is empty (first request before initial fetch completes), trigger a fetch
        if (discordMembersCache.data.length === 0) {
            await refreshDiscordMembers();
        }
        return res.json(discordMembersCache.data);
    });

    server.post('/api/refresh-discord-members', async (req, res) => {
        logger.info('Manual Discord members refresh triggered via API');
        await refreshDiscordMembers();
        return res.json({ status: 'refreshed', count: discordMembersCache.data.length });
    });

    // ntfy topic for the queue-notification signup page. The topic name is public by
    // design (anyone may subscribe); it lives in .env only so the repo never pins it.
    server.get('/api/ntfy-info', (req, res) => {
        const topic = (process.env.NTFY_TOPIC || '').trim();
        if (!topic) return res.status(503).json({ error: 'Notifications are not configured' });
        const ntfyServer = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
        return res.json({ server: ntfyServer, topic });
    });

    server.put('/', async (req, res) => {
        logger.info('PUT: ' + JSON.stringify(req.body));

        const { tokenType, accessToken, rank, referredBy: rawReferredBy } = req.body;
        const validNames = new Set((discordMembersCache.data || []).map(m => m.name));
        const referredBy = (rawReferredBy && validNames.has(rawReferredBy)) ? rawReferredBy : null;

        if (!tokenType || !accessToken) {
            logger.error('Returning 400: Either missing tokentype or accesstoken.');
            return res.status(400).json({ result: 'Missing token information' });
        }

        if (!rank) {
            logger.error('Returning 400: Missing rank selection');
            return res.status(400).json({ result: 'Please select your Dota 2 rank' });
        }

        try {
            logger.info('Fetching userId and Connections');
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
                logger.error('Returning 400: No User ID found.');
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
                logger.error('Returning 400: No Steam ID Linked');
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
                    INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched, rating, referred_by)
                    VALUES (?, ?, datetime('now'), ?, 0, ?, ?)
                    ON CONFLICT(discord_id) DO UPDATE SET
                        steam_id = excluded.steam_id,
                        rating = excluded.rating,
                        referred_by = excluded.referred_by
                `);
                stmt.run(discordID, steamID, config.MOD_ASSIGNMENT, rating, referredBy || null);
            } catch (err) {
                logger.error('DB upsert error:', err.message);
            }

            // Notify local pipe
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
                        'Authorization': `Bot ${BOT_TOKEN}`,
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
        } catch (err) {
            logger.error('Unhandled server error:', err);
            return res.status(500).json({ result: 'Server error occurred' });
        }
    });
}
