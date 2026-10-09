import fetch from 'node-fetch';
import { logger } from '../logger.mjs';
import { config, BOT_TOKEN } from '../config.mjs';

// ─── Per-user guild membership (profile page "Rejoin the Discord") ──────────
// The owner's own profile asks Discord directly whether they are still in the
// server; answers are memoised briefly. Resolves true / false, or null when
// Discord could not be asked (then the caller should assume nothing).
const membershipMemo = new Map(); // discordId -> { value, at }
const MEMBERSHIP_MEMO_TTL = 60 * 1000;

export async function fetchGuildMembership(discordId) {
    const id = String(discordId);
    const memo = membershipMemo.get(id);
    if (memo && Date.now() - memo.at < MEMBERSHIP_MEMO_TTL) return memo.value;
    if (!BOT_TOKEN) return null;
    let value = null;
    try {
        const res = await fetch(`https://discord.com/api/guilds/${config.GUILD_ID}/members/${id}`, {
            headers: { 'Authorization': `Bot ${BOT_TOKEN}` },
        });
        if (res.ok) value = true;
        else if (res.status === 404) value = false;
        else logger.warn(`[Discord] membership check for ${id} returned ${res.status}`);
    } catch (err) {
        logger.warn(`[Discord] membership check for ${id} failed: ${err.message}`);
    }
    if (value !== null) membershipMemo.set(id, { value, at: Date.now() });
    return value;
}

// Drop the memoised answer after we changed it ourselves (guild join via OAuth).
export function forgetGuildMembership(discordId) {
    membershipMemo.delete(String(discordId));
}
