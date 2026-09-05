import { createHash, randomBytes } from 'node:crypto';
import fetch from 'node-fetch';
import { db } from '../db.mjs';
import { config } from '../config.mjs';
import { logger } from '../logger.mjs';

// ─── Discord OAuth (authorization-code flow) + cookie sessions ───────────────
// Requires: CLIENT_ID (config.json, public), CLIENT_SECRET (.env, secret),
// SITE_URL (.env). The redirect URI below must be registered in the Discord
// developer portal for the application.
export const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const CLIENT_ID = String(config.CLIENT_ID || '');
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
export const REDIRECT_URI = SITE_URL ? `${SITE_URL}/api/auth/callback` : '';
export const authEnabled = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

const SESSION_COOKIE = 'gl_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_TTL_MS = 10 * 60 * 1000;
const SECURE_COOKIE = SITE_URL.startsWith('https://');

// ─── OAuth state (CSRF token + what to do when Discord sends the user back) ──
const pendingStates = new Map(); // state -> { mode, returnTo, rank, referredBy, createdAt }

function pruneStates() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of pendingStates) if (v.createdAt < cutoff) pendingStates.delete(k);
}

const MAX_PENDING_STATES = 2000;

export function createOAuthState(data) {
    pruneStates();
    // Hard cap so a flood of /api/auth/login hits can't grow memory within the
    // 10-minute window — drop the oldest entries first.
    while (pendingStates.size >= MAX_PENDING_STATES) {
        pendingStates.delete(pendingStates.keys().next().value);
    }
    const state = randomBytes(24).toString('hex');
    pendingStates.set(state, { ...data, createdAt: Date.now() });
    return state;
}

export function consumeOAuthState(state) {
    if (!state || typeof state !== 'string') return null;
    const data = pendingStates.get(state);
    pendingStates.delete(state);
    if (!data || Date.now() - data.createdAt > STATE_TTL_MS) return null;
    return data;
}

// Only ever send users back to a path on this site.
export function safeReturnTo(raw, fallback = '/profile') {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
    return raw;
}

export function authorizeUrl({ state, scopes }) {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: scopes.join(' '),
        state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(code) {
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
    });
    const res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error(`Discord token exchange failed: ${res.status} ${text.slice(0, 200)}`);
        throw new Error('Discord token exchange failed');
    }
    const data = await res.json();
    return { accessToken: data.access_token, tokenType: data.token_type || 'Bearer', scope: data.scope || '' };
}

export async function fetchDiscordUser(tokenType, accessToken) {
    const res = await fetch('https://discord.com/api/users/@me', {
        headers: { authorization: `${tokenType} ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);
    const u = await res.json();
    if (!u.id) throw new Error('Discord user response had no id');
    return { id: String(u.id), username: u.username || null, globalName: u.global_name || null, avatar: u.avatar || null };
}

export function discordAvatarUrl(discordId, avatarHash) {
    if (avatarHash) {
        const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${ext}?size=128`;
    }
    // Default avatar index for the new username system
    let index = 0;
    try { index = Number((BigInt(discordId) >> 22n) % 6n); } catch { /* keep 0 */ }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// ─── Profiles identity upsert ────────────────────────────────────────────────
const upsertIdentity = db.prepare(`INSERT INTO profiles (discord_id, username, global_name, avatar, created_at, updated_at)
    VALUES (@id, @username, @globalName, @avatar, @now, @now)
    ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name,
        avatar = excluded.avatar, updated_at = excluded.updated_at`);

export function rememberDiscordIdentity(user) {
    upsertIdentity.run({ id: user.id, username: user.username, globalName: user.globalName, avatar: user.avatar, now: Date.now() });
}

// ─── Sessions ────────────────────────────────────────────────────────────────
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const insertSession = db.prepare('INSERT INTO sessions (token_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const selectSession = db.prepare('SELECT discord_id, expires_at FROM sessions WHERE token_hash = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

export function createSession(discordId) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    insertSession.run(hashToken(token), String(discordId), now, now + SESSION_TTL_MS);
    if (Math.random() < 0.05) deleteExpired.run(now); // opportunistic cleanup
    return token;
}

export function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k) continue;
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = ''; }
    }
    return out;
}

// Discord id (string) for the request's session, or null.
export function getSessionDiscordId(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const row = selectSession.get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) { deleteSession.run(hashToken(token)); return null; }
    return String(row.discord_id);
}

export function destroySession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) deleteSession.run(hashToken(token));
}

export function setSessionCookie(res, token) {
    const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
    if (SECURE_COOKIE) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
    const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (SECURE_COOKIE) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

export function requireAuth(req, res, next) {
    const id = getSessionDiscordId(req);
    if (!id) return res.status(401).json({ error: 'Login required' });
    req.discordId = id;
    next();
}
