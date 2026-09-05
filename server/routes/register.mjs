import { logger } from '../logger.mjs';
import { discordMembersCache, refreshDiscordMembers } from '../services/discord.mjs';
import { registerWithDiscordToken } from '../services/registration.mjs';

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

    // Legacy home-page registration: the browser completes Discord's implicit
    // grant and hands us the access token. Logged-in users can also link from
    // their profile via /api/auth/link-steam, which shares the same service.
    server.put('/', async (req, res) => {
        const { tokenType, accessToken, rank, referredBy } = req.body || {};
        logger.info(`PUT /: registration attempt (rank=${rank || 'none'})`);
        const result = await registerWithDiscordToken({ tokenType, accessToken, rank, referredBy });
        return res.status(result.status).json(result.body);
    });
}
