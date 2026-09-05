import fetch from 'node-fetch';
import net from 'net';
import { db } from '../db.mjs';
import { logger } from '../logger.mjs';
import { config, BOT_TOKEN } from '../config.mjs';
import { discordMembersCache } from './discord.mjs';

// Rank -> starting rating. Shared by the legacy home-page flow (PUT /) and the
// logged-in "Link to Steam" flow on profiles.
export const RANK_TO_RATING = {
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
export const RANKS = Object.keys(RANK_TO_RATING);

// Registers a Discord user for the league using a Discord OAuth access token
// that carries the `identify connections guilds.join` scopes: reads their Steam
// connection, upserts the users row, pokes the bot's pipe, and joins them to
// the guild. Returns { status, body } in the shape PUT / has always answered
// with ({ result: string }), plus ids on success.
export async function registerWithDiscordToken({ tokenType, accessToken, rank, referredBy: rawReferredBy }) {
    const validNames = new Set((discordMembersCache.data || []).map(m => m.name));
    const referredBy = (rawReferredBy && validNames.has(rawReferredBy)) ? rawReferredBy : null;

    if (!tokenType || !accessToken) {
        logger.error('Registration: missing tokenType or accessToken');
        return { status: 400, body: { result: 'Missing token information' } };
    }
    if (!rank) {
        logger.error('Registration: missing rank selection');
        return { status: 400, body: { result: 'Please select your Dota 2 rank' } };
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
            logger.error('Registration: no user id in Discord response');
            return { status: 400, body: { result: 'Invalid Discord credentials. Please try again.' } };
        }

        const discordID = user.id;
        let steamID = null;
        let steamName = null;
        for (const conn of Array.isArray(connections) ? connections : []) {
            if (conn.type === 'steam') {
                steamID = conn.id;
                steamName = conn.name;
                break;
            }
        }

        if (!steamID) {
            logger.error('Registration: no Steam connection linked');
            return { status: 400, body: { result: "No Steam ID linked to Discord. Please link under 'Connections' in Discord Settings and Try Again." } };
        }

        const rating = RANK_TO_RATING[rank] || 3000; // Default to 3000 if rank not found
        logger.info(`Converting rank '${rank}' to rating ${rating} for user ${discordID}`);

        try {
            db.prepare(`
                INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched, rating, referred_by)
                VALUES (?, ?, datetime('now'), ?, 0, ?, ?)
                ON CONFLICT(discord_id) DO UPDATE SET
                    steam_id = excluded.steam_id,
                    rating = excluded.rating,
                    referred_by = excluded.referred_by
            `).run(discordID, steamID, config.MOD_ASSIGNMENT, rating, referredBy || null);
        } catch (err) {
            logger.error('DB upsert error:', err.message);
        }

        // Notify local pipe (the bot picks up new registrants from here)
        try {
            const socketPipe = new net.Socket();
            socketPipe.on('error', err => { logger.error('Pipe connection error:', err); });
            socketPipe.connect(config.pipePort, '127.0.0.1', function () {
                socketPipe.write(`${discordID}`);
                socketPipe.end();
            });
        } catch (pipeErr) {
            logger.error('Pipe error:', pipeErr);
        }

        // Add member to guild
        try {
            logger.info({ discordID, guildID: config.GUILD_ID }, 'Attempting to add user to guild');
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
                return { status: 400, body: { result: `Failed to join guild: ${guildRes.status} - ${errText}` } };
            }

            logger.info(`Successfully added ${discordID} to guild.`);
            return { status: 201, body: { result: steamName }, discordID, steamID, steamName };
        } catch (err) {
            logger.error('Guild add error:', err);
            return { status: 500, body: { result: 'Error adding user to guild' } };
        }
    } catch (err) {
        logger.error('Unhandled registration error:', err);
        return { status: 500, body: { result: 'Server error occurred' } };
    }
}
