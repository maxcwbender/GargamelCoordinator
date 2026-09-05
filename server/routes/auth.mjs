import { logger } from '../logger.mjs';
import {
    authEnabled, createOAuthState, consumeOAuthState, safeReturnTo, authorizeUrl,
    exchangeCode, fetchDiscordUser, rememberDiscordIdentity,
    createSession, destroySession, setSessionCookie, clearSessionCookie,
    getSessionDiscordId, requireAuth,
} from '../services/auth.mjs';
import { registerWithDiscordToken, RANKS } from '../services/registration.mjs';
import { buildProfile } from './profile.mjs';

// ─── Website login via Discord ───────────────────────────────────────────────
//   GET  /api/auth/login?returnTo=/path   -> Discord consent (identify)
//   GET  /api/auth/link-steam?rank=&referredBy=  (logged in) -> Discord consent
//        (identify connections guilds.join), then registers via the shared
//        registration service — same result as the home-page flow.
//   GET  /api/auth/callback               -> Discord sends the user back here
//   POST /api/auth/logout
//   GET  /api/auth/me                     -> { enabled, user|null }
export function mountAuthRoutes(server) {
    server.get('/api/auth/login', (req, res) => {
        if (!authEnabled()) return res.status(503).json({ error: 'Login is not configured on this server' });
        const state = createOAuthState({ mode: 'login', returnTo: safeReturnTo(req.query.returnTo) });
        return res.redirect(authorizeUrl({ state, scopes: ['identify'] }));
    });

    server.get('/api/auth/link-steam', requireAuth, (req, res) => {
        if (!authEnabled()) return res.status(503).json({ error: 'Login is not configured on this server' });
        const rank = typeof req.query.rank === 'string' ? req.query.rank : '';
        if (!RANKS.includes(rank)) return res.status(400).json({ error: 'Please select your Dota 2 rank' });
        const referredBy = typeof req.query.referredBy === 'string' ? req.query.referredBy.slice(0, 100) : '';
        const state = createOAuthState({ mode: 'link', rank, referredBy, returnTo: '/profile' });
        return res.redirect(authorizeUrl({ state, scopes: ['identify', 'connections', 'guilds.join'] }));
    });

    server.get('/api/auth/callback', async (req, res) => {
        if (req.query.error) {
            const msg = String(req.query.error_description || req.query.error).slice(0, 200);
            logger.warn(`[Auth] Discord returned error: ${msg}`);
            return res.redirect('/profile?authError=' + encodeURIComponent(msg));
        }
        const pending = consumeOAuthState(req.query.state);
        if (!pending) return res.redirect('/?authError=' + encodeURIComponent('Login session expired — please try again'));

        try {
            const { accessToken, tokenType } = await exchangeCode(String(req.query.code || ''));
            const user = await fetchDiscordUser(tokenType, accessToken);
            rememberDiscordIdentity(user);
            setSessionCookie(res, createSession(user.id));
            logger.info(`[Auth] ${user.username} (${user.id}) logged in (${pending.mode})`);

            if (pending.mode === 'link') {
                const result = await registerWithDiscordToken({
                    tokenType, accessToken, rank: pending.rank, referredBy: pending.referredBy,
                });
                if (result.status >= 400) {
                    return res.redirect('/profile?linkError=' + encodeURIComponent(String(result.body?.result || 'Linking failed')));
                }
                return res.redirect('/profile?linked=1');
            }
            return res.redirect(pending.returnTo || '/profile');
        } catch (err) {
            logger.error(`[Auth] callback failed: ${err.message}`);
            return res.redirect('/?authError=' + encodeURIComponent('Login failed — please try again'));
        }
    });

    server.post('/api/auth/logout', (req, res) => {
        destroySession(req);
        clearSessionCookie(res);
        return res.json({ ok: true });
    });

    server.get('/api/auth/me', (req, res) => {
        const discordId = getSessionDiscordId(req);
        if (!discordId) return res.json({ enabled: authEnabled(), user: null });
        const profile = buildProfile({ discordId }, discordId);
        return res.json({
            enabled: authEnabled(),
            user: {
                displayName: profile?.displayName || 'Player',
                avatarUrl: profile?.discordAvatar || null,
                accountId: profile?.accountId ?? null,
                linked: !!profile?.steam?.linked,
            },
        });
    });
}
