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
// "Top" heroes = the ones the player wins with, ranked by a shrunk win rate:
// (wins + k/2) / (games + k) with k = 6, the same estimator as Best Allies.
// The prior pulls small samples toward 50%, so a 1-0 hero (0.57) sits below
// 4-2 (0.58) and 2-0 (0.63), and 3-0 (0.67) still beats 3-2 (0.55). Heroes
// with a single game only fill in when nothing else qualifies, so a new
// player's card is never empty.
const HERO_MIN_GAMES = 2;
const HERO_SHRINK_K = 6;
const topHeroesStmt = db.prepare(`SELECT hero_id, COUNT(*) AS games, SUM(won) AS wins FROM player_matches
    WHERE account_id = ? AND season = ? AND hero_id IS NOT NULL GROUP BY hero_id
    ORDER BY (COUNT(*) >= ${HERO_MIN_GAMES}) DESC,
             (SUM(won) + ${HERO_SHRINK_K / 2}.0) / (COUNT(*) + ${HERO_SHRINK_K}.0) DESC,
             games DESC, hero_id LIMIT 3`);
const recentMatchesStmt = db.prepare(`SELECT match_id, hero_id, won, kills, deaths, assists, gold_per_min, start_time, duration, game_mode
    FROM player_matches WHERE account_id = ? ORDER BY start_time DESC, match_id DESC LIMIT 10`);
// Best allies: teammates (same match, same side) across the whole season,
// ranked by a shrunk win rate — (wins + k/2) / (games + k) with k = 6 — so a
// 2-0 pair can't leapfrog an 11-game 64% pair, and a 9-17 pair sinks despite
// its raw win count. Minimum 4 games together. Names/avatars from the season
// stats + avatar cache.
const ALLY_MIN_GAMES = 4;
const ALLY_SHRINK_K = 6;
const bestAlliesStmt = db.prepare(`
    SELECT a.account_id, COUNT(*) AS games, SUM(a.won) AS wins,
           ps.personaname, pa.avatar_url
    FROM player_matches me
    JOIN player_matches a
      ON a.match_id = me.match_id AND a.account_id != me.account_id
     AND ((a.player_slot < 128) = (me.player_slot < 128))
    LEFT JOIN player_stats ps ON ps.account_id = a.account_id AND ps.season = @season
    LEFT JOIN player_avatars pa ON pa.account_id = a.account_id
    WHERE me.account_id = @accountId AND me.season = @season
    GROUP BY a.account_id
    HAVING games >= ${ALLY_MIN_GAMES}
    ORDER BY (SUM(a.won) + ${ALLY_SHRINK_K / 2}.0) / (COUNT(*) + ${ALLY_SHRINK_K}.0) DESC, games DESC, a.account_id
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
            ? topHeroesStmt.all(accountId, CURRENT_SEASON).map(r => ({ ...hero(r.hero_id), games: r.games, wins: r.wins, losses: r.games - r.wins }))
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
        bestAllies: accountId != null
            ? bestAlliesStmt.all({ accountId, season: CURRENT_SEASON }).map(r => {
                const rate = r.wins / r.games;
                // Lift: how much better the pair does than the player's own season rate
                const baseline = stats && stats.matches > 0 ? stats.wins / stats.matches : null;
                return {
                    accountId: r.account_id,
                    name: r.personaname || 'Anonymous',
                    avatar: r.avatar_url || null,
                    games: r.games,
                    wins: r.wins,
                    losses: r.games - r.wins,
                    rate,
                    shrunkRate: (r.wins + ALLY_SHRINK_K / 2) / (r.games + ALLY_SHRINK_K),
                    lift: baseline != null ? rate - baseline : null,
                };
            })
            : [],
        allyMinGames: ALLY_MIN_GAMES,
        prefs: {
            favHeroes: parseFavHeroes(prof?.fav_heroes).map(hero),
            favPosition: POSITION_KEYS.has(prof?.fav_position) ? prof.fav_position : null,
            vetoMode: vetoId != null ? (VETOABLE_MODES.find(m => m.id === vetoId) || null) : null,
        },
        isOwner: !!viewerDiscordId && !!discordId && viewerDiscordId === discordId,
    };
}

// ─── MVP / SVP match lists ───────────────────────────────────────────────────
// Rebuilds match cards (same shape as /api/recent-matches) from player_matches
// rows for every Season match where the player won the award (mvp = best on
// the winning team, svp = best on the losing team).
const awardMatchIdsStmt = db.prepare(`SELECT match_id FROM match_mvps
    WHERE account_id = ? AND award_type = ? AND match_id >= ${SEASON_2_FIRST_MATCH} ORDER BY match_id DESC`);
const matchRowsStmt = db.prepare(`SELECT pm.account_id, pm.hero_id, pm.player_slot, pm.won, pm.kills, pm.deaths, pm.assists,
        pm.start_time, pm.duration, pm.game_mode, ps.personaname, pa.avatar_url
    FROM player_matches pm
    LEFT JOIN player_stats ps ON ps.account_id = pm.account_id AND ps.season = ?
    LEFT JOIN player_avatars pa ON pa.account_id = pm.account_id
    WHERE pm.match_id = ? ORDER BY pm.player_slot`);
const matchAwardsStmt = db.prepare('SELECT account_id, award_type FROM match_mvps WHERE match_id = ?');

function buildMatchCard(matchId) {
    const rows = matchRowsStmt.all(CURRENT_SEASON, matchId);
    if (!rows.length) return null;
    const awards = new Map(matchAwardsStmt.all(matchId).map(a => [`${a.award_type}:${a.account_id}`, true]));
    const players = rows.map(r => {
        const isRadiant = r.player_slot < 128;
        const h = hero(r.hero_id);
        return {
            account_id: r.account_id,
            personaname: r.personaname || 'Anonymous',
            player_slot: r.player_slot,
            isRadiant,
            kills: r.kills, deaths: r.deaths, assists: r.assists,
            avatar: r.avatar_url || null,
            hero_id: r.hero_id,
            heroName: h?.name || null,
            heroImg: h?.img || null,
            isMVP: awards.has(`mvp:${r.account_id}`),
            isSVP: awards.has(`svp:${r.account_id}`),
        };
    });
    const first = rows[0];
    const radiantWin = (first.player_slot < 128) ? !!first.won : !first.won;
    return {
        match_id: matchId,
        radiant_win: radiantWin,
        // Team score in Dota is the team's kill count
        radiant_score: players.filter(p => p.isRadiant).reduce((s, p) => s + (p.kills || 0), 0),
        dire_score: players.filter(p => !p.isRadiant).reduce((s, p) => s + (p.kills || 0), 0),
        duration: first.duration,
        start_time: first.start_time,
        game_mode: first.game_mode,
        players,
    };
}

export function mountProfileRoutes(server) {
    // /api/players/:id/mvps and /api/players/:id/svps
    for (const award of ['mvp', 'svp']) {
        server.get(`/api/players/:accountId/${award}s`, (req, res) => {
            const accountId = Number(req.params.accountId);
            if (!Number.isInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'Invalid account id' });
            const profile = buildProfile({ accountId }, getSessionDiscordId(req));
            if (!profile) return res.status(404).json({ error: 'No such player' });
            const matches = awardMatchIdsStmt.all(accountId, award).map(r => buildMatchCard(r.match_id)).filter(Boolean)
                .sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
            return res.json({
                player: { accountId, name: profile.displayName, avatar: profile.steam.avatar || profile.discordAvatar },
                season: CURRENT_SEASON,
                award,
                matches,
            });
        });
    }

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
