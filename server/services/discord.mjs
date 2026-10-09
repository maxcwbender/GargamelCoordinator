import fetch from 'node-fetch';
import { logger } from '../logger.mjs';
import { config, BOT_TOKEN } from '../config.mjs';

// ─── Discord member names + avatars for referral autocomplete ───────────────
export let discordMembersCache = { data: [], lastFetched: 0 };
const DISCORD_MEMBERS_TTL = 12 * 60 * 60 * 1000; // 12 hours

export async function refreshDiscordMembers() {
    try {
        const members = [];
        let after = '0';
        let hasMore = true;

        // Fetch all guild members in batches of 1000 (Discord API max per request)
        while (hasMore) {
            const memberRes = await fetch(
                `https://discord.com/api/guilds/${config.GUILD_ID}/members?limit=1000&after=${after}`, {
                headers: { 'Authorization': `Bot ${BOT_TOKEN}` },
            });
            if (!memberRes.ok) break;

            const batch = await memberRes.json();
            if (batch.length === 0) { hasMore = false; break; }

            for (const m of batch) {
                const displayName = m.nick || m.user?.global_name || m.user?.username;
                if (displayName && !m.user?.bot) {
                    // Build Discord CDN avatar URL (64px for small circular display)
                    let avatar = null;
                    if (m.user?.avatar) {
                        const ext = m.user.avatar.startsWith('a_') ? 'gif' : 'png';
                        avatar = `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.${ext}?size=64`;
                    } else if (m.user?.id) {
                        // Default Discord avatar based on user ID
                        const index = (BigInt(m.user.id) >> 22n) % 6n;
                        avatar = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
                    }
                    members.push({ name: displayName, avatar });
                }
            }

            after = batch[batch.length - 1].user.id;
            if (batch.length < 1000) hasMore = false;
        }

        if (members.length > 0) {
            discordMembersCache = { data: members, lastFetched: Date.now() };
            logger.info(`Refreshed Discord members cache: ${members.length} members with avatars`);
        }
    } catch (err) {
        logger.error({ err }, 'Error refreshing Discord members cache');
    }
}

// ─── Per-user guild membership (profile page "Rejoin the Discord") ──────────
// The 12-hour members cache is too stale to tell whether someone just left, so
// the owner's own profile asks Discord directly; answers are memoised briefly.
// Resolves true / false, or null when Discord could not be asked (then the
// caller should assume nothing).
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

export function startDiscordBackgroundWork() {
    refreshDiscordMembers();
    setInterval(refreshDiscordMembers, DISCORD_MEMBERS_TTL);
}
