// ─── Website accounts: sessions, cookies, CSRF, Discord OAuth code flow ─────
// Hand-rolled on purpose (no express-session/passport): sessions are a SQLite
// table sharing the app's better-sqlite3 handle, cookies are opaque random
// tokens stored hashed, and the Discord flow is the authorization-code grant
// (tokens live server-side only — never in client JS, URLs, or logs).
import fetch from 'node-fetch';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const SESSION_RENEW_MS = 15 * 24 * 60 * 60 * 1000; // sliding renewal when < 15d left
const STATE_TTL_S = 600;                           // oauth_state cookie lifetime
const SESSION_COOKIE = 'gg_session';
const STATE_COOKIE = 'oauth_state';

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

// Equal-length compare regardless of input lengths (same trick as planningSafeEqual)
function safeEqual(a, b) {
    return timingSafeEqual(
        createHash('sha256').update(String(a)).digest(),
        createHash('sha256').update(String(b)).digest()
    );
}

function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        try {
            out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
        } catch (_) { /* skip malformed cookie */ }
    }
    return out;
}

function cookieStr(name, value, { maxAge, path = '/' } = {}) {
    let s = `${name}=${encodeURIComponent(value)}; Path=${path}`;
    if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
    return s + '; HttpOnly; Secure; SameSite=Lax';
}

// Only allow same-origin relative redirect targets ('/foo', not '//evil' or URLs)
function sanitizeNext(next) {
    if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
    return next;
}

// Build the same CDN avatar URL shape used by refreshDiscordMembers()
export function discordAvatarUrl(user) {
    if (user?.avatar) {
        const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
    }
    if (user?.id) {
        const index = (BigInt(user.id) >> 22n) % 6n;
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
    return null;
}

export function createAuth({ db, logger, config }) {
    const CLIENT_ID = config.CLIENT_ID;
    const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
    const SITE_URL = (process.env.SITE_URL || 'https://www.gargamel-league.com').replace(/\/$/, '');
    const REDIRECT_URI = `${SITE_URL}/auth/discord/callback`;
    const OAUTH_SCOPES = 'identify connections guilds.join';

    if (!CLIENT_SECRET) logger.warn('CLIENT_SECRET is not set — Discord login will fail');

    // ── Session store ──────────────────────────────────────────────────────
    // discord_id is CAST to TEXT on read: snowflakes exceed 2^53 and would
    // silently lose precision as JS numbers.
    const insertSession = db.prepare(`
        INSERT INTO sessions (token_hash, discord_id, csrf_token, discord_username,
            discord_avatar_url, access_token, refresh_token, token_expires_at, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const selectSession = db.prepare(`
        SELECT token_hash, CAST(discord_id AS TEXT) AS discord_id, csrf_token,
               discord_username, discord_avatar_url, access_token, refresh_token,
               token_expires_at, expires_at
        FROM sessions WHERE token_hash = ? AND expires_at > ?
    `);
    const renewSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');
    const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    const sweepSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const updateTokens = db.prepare(`
        UPDATE sessions SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE token_hash = ?
    `);

    setInterval(() => {
        try {
            const { changes } = sweepSessions.run(Date.now());
            if (changes > 0) logger.info(`Session sweep: removed ${changes} expired sessions`);
        } catch (err) {
            logger.error('Session sweep error:', err.message);
        }
    }, 60 * 60 * 1000).unref();

    function createSession(user, tokens) {
        const token = randomBytes(32).toString('hex');
        const now = Date.now();
        insertSession.run(
            sha256hex(token),
            String(user.id),
            randomBytes(16).toString('hex'),
            user.global_name || user.username || null,
            discordAvatarUrl(user),
            tokens.access_token || null,
            tokens.refresh_token || null,
            tokens.expires_in ? now + tokens.expires_in * 1000 : null,
            now,
            now + SESSION_TTL_MS
        );
        return token;
    }

    function getSession(req) {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (!token) return null;
        const row = selectSession.get(sha256hex(token), Date.now());
        if (!row) return null;
        if (row.expires_at - Date.now() < SESSION_RENEW_MS) {
            renewSession.run(Date.now() + SESSION_TTL_MS, row.token_hash);
        }
        return row;
    }

    // ── Middleware ─────────────────────────────────────────────────────────
    function requireAuth(req, res, next) {
        const session = getSession(req);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        req.session = session;
        next();
    }

    function requireCsrf(req, res, next) {
        const header = req.get('x-csrf-token') || '';
        if (!header || !safeEqual(header, req.session.csrf_token)) {
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
        next();
    }

    // Refresh the session's Discord access token; returns the fresh token or null.
    async function refreshDiscordToken(session) {
        if (!session.refresh_token) return null;
        try {
            const res = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: session.refresh_token,
                }),
            });
            if (!res.ok) return null;
            const tokens = await res.json();
            updateTokens.run(
                tokens.access_token,
                tokens.refresh_token || session.refresh_token,
                tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
                session.token_hash
            );
            return tokens.access_token;
        } catch (err) {
            logger.error('Discord token refresh error:', err.message);
            return null;
        }
    }

    // ── Routes ─────────────────────────────────────────────────────────────
    function registerRoutes(server) {
        server.get('/auth/discord/login', (req, res) => {
            const state = randomBytes(16).toString('hex');
            const next = sanitizeNext(req.query.next);
            res.setHeader('Set-Cookie', cookieStr(STATE_COOKIE, `${state}|${next}`, {
                maxAge: STATE_TTL_S, path: '/auth',
            }));
            const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: 'code',
                redirect_uri: REDIRECT_URI,
                scope: OAUTH_SCOPES,
                state,
                prompt: 'none',
            });
            return res.redirect(url);
        });

        server.get('/auth/discord/callback', async (req, res) => {
            const { code, state } = req.query;
            const stateCookie = parseCookies(req)[STATE_COOKIE] || '';
            const sep = stateCookie.indexOf('|');
            const expectedState = sep === -1 ? '' : stateCookie.slice(0, sep);
            const next = sanitizeNext(sep === -1 ? '/' : stateCookie.slice(sep + 1));
            // Consume the state cookie regardless of outcome
            res.setHeader('Set-Cookie', cookieStr(STATE_COOKIE, '', { maxAge: 0, path: '/auth' }));

            if (!code || !state || !expectedState || !safeEqual(state, expectedState)) {
                logger.error('OAuth callback rejected: missing code or state mismatch');
                return res.status(400).send('Login failed (state mismatch). Please try again.');
            }

            try {
                const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: CLIENT_ID,
                        client_secret: CLIENT_SECRET,
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: REDIRECT_URI,
                    }),
                });
                if (!tokenRes.ok) {
                    logger.error(`OAuth token exchange failed: ${tokenRes.status}`);
                    return res.status(400).send('Login failed (token exchange). Please try again.');
                }
                const tokens = await tokenRes.json();

                const userRes = await fetch('https://discord.com/api/users/@me', {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                });
                const user = await userRes.json();
                if (!user.id) {
                    logger.error('OAuth callback: /users/@me returned no id');
                    return res.status(400).send('Login failed (identity). Please try again.');
                }

                const token = createSession(user, tokens);
                res.setHeader('Set-Cookie', [
                    cookieStr(STATE_COOKIE, '', { maxAge: 0, path: '/auth' }),
                    cookieStr(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000 }),
                ]);
                logger.info(`Login: ${user.id} (${user.username})`);
                return res.redirect(next);
            } catch (err) {
                logger.error('OAuth callback error:', err.message);
                return res.status(500).send('Login failed (server error). Please try again.');
            }
        });

        server.post('/auth/logout', requireAuth, requireCsrf, (req, res) => {
            deleteSession.run(req.session.token_hash);
            res.setHeader('Set-Cookie', cookieStr(SESSION_COOKIE, '', { maxAge: 0 }));
            return res.json({ result: 'Logged out' });
        });

        server.get('/api/me', (req, res) => {
            const session = getSession(req);
            if (!session) return res.status(401).json({ error: 'Not logged in' });
            const registered = !!db.prepare('SELECT 1 FROM users WHERE discord_id = ?')
                .get(session.discord_id);
            return res.json({
                discordId: session.discord_id,
                username: session.discord_username,
                avatarUrl: session.discord_avatar_url,
                registered,
                csrfToken: session.csrf_token,
            });
        });
    }

    return { registerRoutes, requireAuth, requireCsrf, getSession, refreshDiscordToken, SITE_URL };
}
