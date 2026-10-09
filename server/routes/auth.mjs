import { logger } from '../logger.mjs';
import {
    authEnabled, createOAuthState, consumeOAuthState, safeReturnTo, authorizeUrl,
    exchangeCode, fetchDiscordUser, rememberDiscordIdentity,
    createSession, destroySession, setSessionCookie, clearSessionCookie,
    getSessionDiscordId, requireAuth,
} from '../services/auth.mjs';
import { registerWithDiscordToken, rejoinGuildWithDiscordToken, getRegistration, normalizeReferralSource, RANKS } from '../services/registration.mjs';
import { buildProfile } from './profile.mjs';
import { forgetGuildMembership } from '../services/discord.mjs';

// ─── Website login via Discord ───────────────────────────────────────────────
//   GET  /api/auth/login?returnTo=/path   -> Discord consent (identify)
//   GET  /api/auth/link-steam?rank=&ref=  (logged in) -> Discord consent
//        (identify connections guilds.join), then registers via the shared
//        registration service — same result as the home-page flow. `ref` is the
//        hidden promo-link tag the client captured (never shown to the user).
//   GET  /api/auth/rejoin                 (logged in, registered) -> Discord consent
//        (identify guilds.join), then re-adds them to the Discord server; the bot
//        re-queues them for mod review as a returning player.
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
        const referralSource = normalizeReferralSource(req.query.ref);
        const state = createOAuthState({ mode: 'link', rank, referralSource, returnTo: '/profile' });
        return res.redirect(authorizeUrl({ state, scopes: ['identify', 'connections', 'guilds.join'] }));
    });

    server.get('/api/auth/rejoin', requireAuth, (req, res) => {
        if (!authEnabled()) return res.status(503).json({ error: 'Login is not configured on this server' });
        if (!getRegistration(req.discordId)) {
            return res.redirect('/profile?rejoinError=' + encodeURIComponent('You are not registered yet. Link your Steam account first.'));
        }
        const state = createOAuthState({ mode: 'rejoin', returnTo: '/profile' });
        return res.redirect(authorizeUrl({ state, scopes: ['identify', 'guilds.join'] }));
    });

    server.get('/api/auth/callback', async (req, res) => {
        if (req.query.error) {
            const msg = String(req.query.error_description || req.query.error).slice(0, 200);
            logger.warn(`[Auth] Discord returned error: ${msg}`);
            return res.redirect('/profile?authError=' + encodeURIComponent(msg));
        }
        const pending = consumeOAuthState(req.query.state);
        if (!pending) return res.redirect('/?authError=' + encodeURIComponent('Login session expired. Please try again'));

        try {
            const { accessToken, tokenType } = await exchangeCode(String(req.query.code || ''));
            const user = await fetchDiscordUser(tokenType, accessToken);
            rememberDiscordIdentity(user);
            setSessionCookie(res, createSession(user.id));
            logger.info(`[Auth] ${user.username} (${user.id}) logged in (${pending.mode})`);

            if (pending.mode === 'link') {
                const result = await registerWithDiscordToken({
                    tokenType, accessToken, rank: pending.rank, referralSource: pending.referralSource,
                });
                if (result.status >= 400) {
                    return res.redirect('/profile?linkError=' + encodeURIComponent(String(result.body?.result || 'Linking failed')));
                }
                forgetGuildMembership(user.id);
                return res.redirect('/profile?linked=1');
            }
            if (pending.mode === 'rejoin') {
                const result = await rejoinGuildWithDiscordToken({ tokenType, accessToken, discordID: user.id });
                if (result.status >= 400) {
                    return res.redirect('/profile?rejoinError=' + encodeURIComponent(String(result.body?.result || 'Rejoin failed')));
                }
                forgetGuildMembership(user.id);
                logger.info(`[Auth] ${user.username} (${user.id}) rejoined the Discord server via profile`);
                return res.redirect('/profile?rejoined=1');
            }
            return res.redirect(pending.returnTo || '/profile');
        } catch (err) {
            logger.error(`[Auth] callback failed: ${err.message}`);
            return res.redirect('/?authError=' + encodeURIComponent('Login failed. Please try again'));
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
