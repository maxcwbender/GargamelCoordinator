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
        logger.error('Error refreshing Discord members cache:', err);
    }
}

export function startDiscordBackgroundWork() {
    refreshDiscordMembers();
    setInterval(refreshDiscordMembers, DISCORD_MEMBERS_TTL);
}
