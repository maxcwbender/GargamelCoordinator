import { logger } from '../logger.mjs';
import { registerWithDiscordToken, normalizeReferralSource } from '../services/registration.mjs';

// Registration flow (Discord OAuth PUT /) and the ntfy notification signup
// info endpoint.
export function mountRegisterRoutes(server) {
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
    // referralSource is the hidden ?ref= tag from the promo link the visitor
    // arrived through (see client/src/referral.js); it is stored for mods only.
    server.put('/', async (req, res) => {
        const { tokenType, accessToken, rank, referralSource } = req.body || {};
        logger.info(`PUT /: registration attempt (rank=${rank || 'none'}, ref=${normalizeReferralSource(referralSource) || 'none'})`);
        const result = await registerWithDiscordToken({ tokenType, accessToken, rank, referralSource });
        return res.status(result.status).json(result.body);
    });
}
