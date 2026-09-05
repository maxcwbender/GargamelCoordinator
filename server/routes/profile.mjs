import { db } from '../db.mjs';
import { logger } from '../logger.mjs';
import { CURRENT_SEASON, SEASON_2_FIRST_MATCH } from '../config.mjs';
import { dotaConstants } from '../services/opendota.mjs';
import { getSessionDiscordId, requireAuth, discordAvatarUrl } from '../services/auth.mjs';

// ─── Player profiles: public stats + owner-editable preferences ─────────────

export const POSITIONS = [
    { key: 'carry', label: 'Carry' },
    { key: 'mid', label: 'Mid' },
    { key: 'offlane', label: 'Offlane' },
    { key: 'soft_support', label: 'Soft Support' },
    { key: 'hard_support', label: 'Hard Support' },
];

// Dota game-mode enum values, matching lobbymanager.go and the bot's mode_map.
// The veto is stored as this integer so the bot can later subtract vetoed modes
// straight from its vote options. Reverse Captains Mode (8), Mid Only (11) and
// All Random Deathmatch (20) are deliberately not offered — never in votes.
export const VETOABLE_MODES = [
    { id: 2, label: 'Captains Mode' },
    { id: 3, label: 'Random Draft' },
    { id: 4, label: 'Single Draft' },
    { id: 5, label: 'All Random' },
    { id: 12, label: 'Least Played' },
    { id: 16, label: "Captain's Draft" },
    { id: 18, label: 'Ability Draft' },
    { id: 22, label: 'Ranked All Pick' },
    { id: 23, label: 'Turbo' },
];
const VETOABLE_IDS = new Set(VETOABLE_MODES.map(m => m.id));
const POSITION_KEYS = new Set(POSITIONS.map(p => p.key));
const MAX_FAV_HEROES = 3;

// users.steam_id is a SteamID64; OpenDota/player_stats use the 32-bit account
// id. Both ids exceed Number's safe range, so the math is done in BigInt.
const STEAM64_BASE = 76561197960265728n;
export function accountIdFromSteam64(steam64) {
    try {
        const v = BigInt(String(steam64)) - STEAM64_BASE;
        return (v > 0n && v < 4294967296n) ? Number(v) : null;
    } catch { return null; }
}
export const steam64FromAccountId = (accountId) => (BigInt(accountId) + STEAM64_BASE).toString();

const userByDiscord = db.prepare('SELECT CAST(discord_id AS TEXT) AS discord_id, CAST(steam_id AS TEXT) AS steam_id FROM users WHERE CAST(discord_id AS TEXT) = ?');
const userBySteam = db.prepare('SELECT CAST(discord_id AS TEXT) AS discord_id, CAST(steam_id AS TEXT) AS steam_id FROM users WHERE CAST(steam_id AS TEXT) = ?');
const profileByDiscord = db.prepare('SELECT * FROM profiles WHERE discord_id = ?');
const statsByAccount = db.prepare('SELECT personaname, wins, losses, matches, kills, deaths, assists, gold_per_minute FROM player_stats WHERE account_id = ? AND season = ?');
const avatarByAccount = db.prepare('SELECT avatar_url FROM player_avatars WHERE account_id = ?');
const awardCounts = db.prepare(`SELECT award_type, COUNT(*) AS c FROM match_mvps WHERE account_id = ? AND match_id >= ${SEASON_2_FIRST_MATCH} GROUP BY award_type`);
const topHeroesStmt = db.prepare(`SELECT hero_id, COUNT(*) AS games, SUM(won) AS wins FROM player_matches
    WHERE account_id = ? AND season = ? AND hero_id IS NOT NULL GROUP BY hero_id ORDER BY games DESC, wins DESC LIMIT 3`);
const recentMatchesStmt = db.prepare(`SELECT match_id, hero_id, won, kills, deaths, assists, gold_per_min, start_time, duration, game_mode
    FROM player_matches WHERE account_id = ? ORDER BY start_time DESC, match_id DESC LIMIT 10`);
// Teammates (same match, same side) across the player's last N games, ranked by
// wins together. Names/avatars come from the season stats + avatar cache.
const ALLY_WINDOW = 30;
const recentAlliesStmt = db.prepare(`
    SELECT a.account_id, COUNT(*) AS games, SUM(a.won) AS wins,
           ps.personaname, pa.avatar_url
    FROM player_matches me
    JOIN player_matches a
      ON a.match_id = me.match_id AND a.account_id != me.account_id
     AND ((a.player_slot < 128) = (me.player_slot < 128))
    LEFT JOIN player_stats ps ON ps.account_id = a.account_id AND ps.season = @season
    LEFT JOIN player_avatars pa ON pa.account_id = a.account_id
    WHERE me.account_id = @accountId
      AND me.match_id IN (SELECT match_id FROM player_matches WHERE account_id = @accountId ORDER BY start_time DESC, match_id DESC LIMIT ${ALLY_WINDOW})
    GROUP BY a.account_id
    HAVING games >= 2
    ORDER BY wins DESC, games DESC, a.account_id
    LIMIT 5`);
const upsertPrefs = db.prepare(`INSERT INTO profiles (discord_id, fav_heroes, fav_position, veto_mode, created_at, updated_at)
    VALUES (@id, @favHeroes, @favPosition, @vetoMode, @now, @now)
    ON CONFLICT(discord_id) DO UPDATE SET fav_heroes = excluded.fav_heroes, fav_position = excluded.fav_position,
        veto_mode = excluded.veto_mode, updated_at = excluded.updated_at`);

function hero(id) {
    if (id == null) return null;
    const h = dotaConstants.heroes[id];
    return { id: Number(id), name: h?.name || `Hero #${id}`, img: h?.img || null };
}

function parseFavHeroes(text) {
    try {
        const arr = JSON.parse(text || '[]');
        return Array.isArray(arr) ? arr.filter(Number.isInteger).slice(0, MAX_FAV_HEROES) : [];
    } catch { return []; }
}

// Assemble the profile payload for a player identified by either their
// OpenDota account id (public URLs) or Discord id (the logged-in user).
// Returns null when nothing at all is known about them.
export function buildProfile({ accountId = null, discordId = null }, viewerDiscordId = null) {
    let user = null;
    if (discordId) user = userByDiscord.get(discordId) || null;
    else if (accountId != null) user = userBySteam.get(steam64FromAccountId(accountId)) || null;
    if (user) {
        discordId = user.discord_id;
        accountId = accountIdFromSteam64(user.steam_id);
    }

    const prof = discordId ? (profileByDiscord.get(discordId) || null) : null;
    const stats = accountId != null ? (statsByAccount.get(accountId, CURRENT_SEASON) || null) : null;
    if (!user && !prof && !stats) return null;

    const avatarRow = accountId != null ? avatarByAccount.get(accountId) : null;
    const awards = {};
    if (accountId != null) for (const r of awardCounts.all(accountId)) awards[r.award_type] = r.c;

    const displayName = prof?.global_name || prof?.username || stats?.personaname || 'Unknown Player';
    const vetoId = prof?.veto_mode != null ? Number(prof.veto_mode) : null;

    return {
        accountId,
        displayName,
        steamName: stats?.personaname || null,
        discordName: prof?.username || null,
        discordAvatar: discordId ? discordAvatarUrl(discordId, prof?.avatar) : null,
        hasAccount: !!prof, // has logged into the website at least once
        steam: {
            linked: !!user?.steam_id,
            avatar: avatarRow?.avatar_url || null,
            profileUrl: user?.steam_id ? `https://steamcommunity.com/profiles/${user.steam_id}` : null,
        },
        opendotaUrl: accountId != null ? `https://www.opendota.com/players/${accountId}` : null,
        season: stats ? {
            number: CURRENT_SEASON,
            wins: stats.wins,
            losses: stats.losses,
            matches: stats.matches,
            kda: stats.deaths > 0 ? (stats.kills + stats.assists) / stats.deaths : (stats.kills + stats.assists),
            avgGPM: stats.matches > 0 ? stats.gold_per_minute / stats.matches : 0,
            mvpCount: awards.mvp || 0,
            svpCount: awards.svp || 0,
        } : null,
        topHeroes: accountId != null
            ? topHeroesStmt.all(accountId, CURRENT_SEASON).map(r => ({ ...hero(r.hero_id), games: r.games, wins: r.wins }))
            : [],
        recentMatches: accountId != null
            ? recentMatchesStmt.all(accountId).map(r => ({
                matchId: r.match_id,
                hero: hero(r.hero_id),
                won: !!r.won,
                kills: r.kills, deaths: r.deaths, assists: r.assists,
                gpm: r.gold_per_min,
                startTime: r.start_time,
                duration: r.duration,
                gameMode: r.game_mode,
            }))
            : [],
        recentAllies: accountId != null
            ? recentAlliesStmt.all({ accountId, season: CURRENT_SEASON }).map(r => ({
                accountId: r.account_id,
                name: r.personaname || 'Anonymous',
                avatar: r.avatar_url || null,
                games: r.games,
                wins: r.wins,
                losses: r.games - r.wins,
            }))
            : [],
        allyWindow: ALLY_WINDOW,
        prefs: {
            favHeroes: parseFavHeroes(prof?.fav_heroes).map(hero),
            favPosition: POSITION_KEYS.has(prof?.fav_position) ? prof.fav_position : null,
            vetoMode: vetoId != null ? (VETOABLE_MODES.find(m => m.id === vetoId) || null) : null,
        },
        isOwner: !!viewerDiscordId && !!discordId && viewerDiscordId === discordId,
    };
}

export function mountProfileRoutes(server) {
    // Hero list for the favorite-hero pickers (from cached OpenDota constants).
    server.get('/api/heroes', (req, res) => {
        const heroes = Object.entries(dotaConstants.heroes)
            .map(([id, h]) => ({ id: Number(id), name: h.name, img: h.img }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return res.json(heroes);
    });

    server.get('/api/profile-options', (req, res) => {
        return res.json({ positions: POSITIONS, vetoModes: VETOABLE_MODES });
    });

    // Public profile by OpenDota account id — works for anyone who has played a
    // league match, registered or not.
    server.get('/api/players/:accountId/profile', (req, res) => {
        const accountId = Number(req.params.accountId);
        if (!Number.isInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'Invalid account id' });
        const profile = buildProfile({ accountId }, getSessionDiscordId(req));
        if (!profile) return res.status(404).json({ error: 'No such player' });
        return res.json(profile);
    });

    server.get('/api/profile/me', requireAuth, (req, res) => {
        const profile = buildProfile({ discordId: req.discordId }, req.discordId);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        return res.json(profile);
    });

    // Owner-only preferences: up to 3 favorite heroes, a favorite position,
    // and one vetoed game mode.
    server.put('/api/profile/prefs', requireAuth, (req, res) => {
        const body = req.body || {};

        let favHeroes = body.favHeroes;
        if (favHeroes == null) favHeroes = [];
        if (!Array.isArray(favHeroes)) return res.status(400).json({ error: 'favHeroes must be an array' });
        favHeroes = [...new Set(favHeroes.map(Number))];
        if (favHeroes.length > MAX_FAV_HEROES) return res.status(400).json({ error: `Pick at most ${MAX_FAV_HEROES} favorite heroes` });
        const heroesLoaded = Object.keys(dotaConstants.heroes).length > 0;
        for (const id of favHeroes) {
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid hero id' });
            if (heroesLoaded && !dotaConstants.heroes[id]) return res.status(400).json({ error: `Unknown hero id ${id}` });
        }

        const favPosition = body.favPosition == null || body.favPosition === '' ? null : String(body.favPosition);
        if (favPosition !== null && !POSITION_KEYS.has(favPosition)) return res.status(400).json({ error: 'Invalid position' });

        const vetoMode = body.vetoMode == null || body.vetoMode === '' ? null : Number(body.vetoMode);
        if (vetoMode !== null && !VETOABLE_IDS.has(vetoMode)) return res.status(400).json({ error: 'That game mode cannot be vetoed' });

        upsertPrefs.run({ id: req.discordId, favHeroes: JSON.stringify(favHeroes), favPosition, vetoMode, now: Date.now() });
        logger.info(`[Profile] ${req.discordId} updated prefs: heroes=${favHeroes.join(',') || 'none'} position=${favPosition || 'none'} veto=${vetoMode ?? 'none'}`);
        return res.json(buildProfile({ discordId: req.discordId }, req.discordId));
    });
}
