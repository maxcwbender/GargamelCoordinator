import fetch from 'node-fetch';
import net from 'net';
import { db } from '../db.mjs';
import { logger } from '../logger.mjs';
import { config, BOT_TOKEN } from '../config.mjs';
import { discordMembersCache } from './discord.mjs';

// ─── Referral attribution ───────────────────────────────────────────────────
// Two sources, stored in two columns on users and tallied in referral_stats:
//   referral_source — hidden tag from a promo link (https://www.gargamel-league.com/?ref=reddit).
//                     The client captures it and sends it silently; the form's
//                     "Referred By" box is hidden when one is present.
//   referred_by     — the Discord member a regular visitor picked in that box.

// Any lower-case slug is accepted so new sources need no code change. Returns
// null for nothing usable. Mirrors client/src/referral.js.
export function normalizeReferralSource(raw) {
    if (typeof raw !== 'string') return null;
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    return slug || null;
}

// Only a current guild member's display name counts; anything else is dropped.
export function normalizeReferredBy(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const validNames = new Set((discordMembersCache.data || []).map(m => m.name));
    return validNames.has(raw) ? raw : null;
}

// referral_stats: how many FIRST-TIME registrations each referral link tag
// ('link') and each referring player ('player') has brought in. Re-registrations
// (same Discord id again) are not counted.
const bumpReferralStat = db.prepare(`
    INSERT INTO referral_stats (kind, key, count, first_at, last_at)
    VALUES (?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(kind, key) DO UPDATE SET count = count + 1, last_at = excluded.last_at
`);
const unbumpReferralStat = db.prepare(
    'UPDATE referral_stats SET count = count - 1 WHERE kind = ? AND key = ? AND count > 0'
);
const dropEmptyReferralStats = db.prepare('DELETE FROM referral_stats WHERE count <= 0');

export function recordReferralStats({ referralSource, referredBy }) {
    if (referralSource) bumpReferralStat.run('link', referralSource);
    if (referredBy) bumpReferralStat.run('player', referredBy);
}

// Reverse recordReferralStats (used when a test registration is removed).
export function forgetReferralStats({ referralSource, referredBy }) {
    if (referralSource) unbumpReferralStat.run('link', referralSource);
    if (referredBy) unbumpReferralStat.run('player', referredBy);
    dropEmptyReferralStats.run();
}

export function listReferralStats() {
    return db.prepare('SELECT kind, key, count, first_at, last_at FROM referral_stats ORDER BY kind, count DESC, key').all();
}

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

const selectRegistration = db.prepare(
    'SELECT CAST(discord_id AS TEXT) AS discord_id, CAST(steam_id AS TEXT) AS steam_id, rating, modsRemaining FROM users WHERE CAST(discord_id AS TEXT) = ?'
);

// The users row for a Discord id, or null if they never registered.
export function getRegistration(discordID) {
    return selectRegistration.get(String(discordID)) || null;
}

// Writes (or refreshes) the users row for a registration. A new row enters the
// mod queue with the full MOD_ASSIGNMENT count and bumps referral_stats; an
// existing row keeps its rating and queue state and only gets its Steam link
// and referral attribution refreshed (never counted twice). Callers pass an
// already-validated referredBy (see normalizeReferredBy). Shared by the OAuth
// flows and scripts/fake-register.mjs. Returns { isNew }.
export const saveRegistration = db.transaction(({ discordID, steamID, rating, referralSource, referredBy }) => {
    const source = normalizeReferralSource(referralSource);
    const player = referredBy || null;
    const isNew = !getRegistration(discordID);
    db.prepare(`
        INSERT INTO users (discord_id, steam_id, dateCreated, modsRemaining, timesVouched, rating, referral_source, referred_by)
        VALUES (?, ?, datetime('now'), ?, 0, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET
            steam_id = excluded.steam_id,
            referral_source = COALESCE(excluded.referral_source, referral_source),
            referred_by = COALESCE(excluded.referred_by, referred_by)
    `).run(String(discordID), String(steamID), config.MOD_ASSIGNMENT, rating, source, player);
    if (isNew) recordReferralStats({ referralSource: source, referredBy: player });
    return { isNew };
});

// Tell the bot (TCP pipe on localhost) that a registration for discordID was
// written; it adds the Steam friend and announces new registrants to the mods.
export function notifyBotPipe(discordID) {
    try {
        const socketPipe = new net.Socket();
        socketPipe.on('error', err => { logger.error({ err }, 'Pipe connection error'); });
        socketPipe.connect(config.pipePort, '127.0.0.1', function () {
            socketPipe.write(`${discordID}`);
            socketPipe.end();
        });
    } catch (err) {
        logger.error({ err }, 'Pipe error');
    }
}

// PUT the user into the guild with their OAuth token (needs the guilds.join
// scope). 201 = joined, 204 = was already a member. Returns { status, body }
// in the registration result shape on failure, or null on success.
async function addMemberToGuild(discordID, accessToken) {
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
            logger.error(`Failed to add user ${discordID} to guild: ${guildRes.status} ${errText}`);
            return { status: 400, body: { result: `Failed to join guild: ${guildRes.status} - ${errText}` } };
        }

        logger.info(`Successfully added ${discordID} to guild (${guildRes.status === 204 ? 'already a member' : 'joined'}).`);
        return null;
    } catch (err) {
        logger.error({ err }, 'Guild add error');
        return { status: 500, body: { result: 'Error adding user to guild' } };
    }
}

// Registers a Discord user for the league using a Discord OAuth access token
// that carries the `identify connections guilds.join` scopes: reads their Steam
// connection, upserts the users row, pokes the bot's pipe, and joins them to
// the guild. Returns { status, body } in the shape PUT / has always answered
// with ({ result: string }), plus ids on success.
//
// A player who registered before keeps their rating (their MMR history is the
// better signal than a freshly self-reported rank); only the Steam link and the
// referral attribution are refreshed. If they had left the Discord server, the
// bot's member-join handler puts them back into the registration queue as a
// returning player.
//
// referralSource is the hidden promo-link tag and referredBy the Discord member
// picked on the form (see the attribution section above); both are stored for
// mods and never echoed back to the registrant.
export async function registerWithDiscordToken({ tokenType, accessToken, rank, referralSource: rawReferralSource, referredBy: rawReferredBy }) {
    const referralSource = normalizeReferralSource(rawReferralSource);
    const referredBy = normalizeReferredBy(rawReferredBy);

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
        const existing = getRegistration(discordID);
        if (existing) {
            logger.info(`Registration: ${discordID} is already registered (rating ${existing.rating}, steam ${existing.steam_id}); keeping their rating, refreshing steam/referral source`);
        } else {
            logger.info(`Converting rank '${rank}' to rating ${rating} for user ${discordID}`);
        }
        if (referralSource) logger.info(`Registration: ${discordID} arrived via referral source '${referralSource}'`);
        if (referredBy) logger.info(`Registration: ${discordID} was referred by '${referredBy}'`);

        try {
            saveRegistration({ discordID, steamID, rating, referralSource, referredBy });
        } catch (err) {
            logger.error({ err }, 'DB upsert error');
        }

        // Notify local pipe (the bot picks up new registrants from here)
        notifyBotPipe(discordID);

        // Add member to guild
        const failure = await addMemberToGuild(discordID, accessToken);
        if (failure) return failure;
        return { status: 201, body: { result: steamName }, discordID, steamID, steamName };
    } catch (err) {
        logger.error({ err }, 'Unhandled registration error');
        return { status: 500, body: { result: 'Server error occurred' } };
    }
}

// Puts an already-registered player back into the Discord server using an
// OAuth token with the `identify guilds.join` scopes (profile page "Rejoin"
// button). Nothing about their registration is changed here: the bot's
// member-join handler re-queues them for mod review with their old rating.
export async function rejoinGuildWithDiscordToken({ tokenType, accessToken, discordID }) {
    if (!tokenType || !accessToken) {
        return { status: 400, body: { result: 'Missing token information' } };
    }
    try {
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenType} ${accessToken}` },
        });
        const user = await userRes.json();
        if (!user.id || String(user.id) !== String(discordID)) {
            logger.error(`Rejoin: token user ${user.id || 'none'} does not match session user ${discordID}`);
            return { status: 400, body: { result: 'Discord account mismatch. Please log in again.' } };
        }
        const existing = getRegistration(discordID);
        if (!existing) {
            return { status: 400, body: { result: 'You are not registered yet. Link your Steam account first.' } };
        }
        logger.info(`Rejoin: returning player ${discordID} (rating ${existing.rating}) rejoining the guild`);
        const failure = await addMemberToGuild(discordID, accessToken);
        if (failure) return failure;
        return { status: 200, body: { result: 'rejoined' }, discordID };
    } catch (err) {
        logger.error({ err }, 'Unhandled rejoin error');
        return { status: 500, body: { result: 'Server error occurred' } };
    }
}
