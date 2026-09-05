import { db } from '../db.mjs';
import { logger } from '../logger.mjs';
import { config, CURRENT_SEASON, SEASON_2_FIRST_MATCH, PLAYER_STATS_TTL_MS } from '../config.mjs';
import { playerStatsCache } from '../services/opendota.mjs';
import { accountIdFromSteam64 } from './profile.mjs';

// ─── Season rankings: overview / core / support superlatives + MMR history ──
// Everything is computed from player_matches (one row per player per match,
// with a derived core/support role) and the bot's own match_players table
// (MMR snapshot at the start of every game). Season 2 only.

const CACHE_MS = 60 * 1000;
let cache = { data: null, at: 0 };

const aggStmt = db.prepare(`
    SELECT account_id, COUNT(*) AS games, SUM(won) AS wins,
           SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(assists) AS assists,
           SUM(gold_per_min) AS gpm, SUM(last_hits) AS last_hits, SUM(denies) AS denies,
           SUM(hero_damage) AS hero_damage, SUM(tower_damage) AS tower_damage, SUM(hero_healing) AS hero_healing,
           SUM(obs_placed + sen_placed) AS wards, SUM(observer_kills) AS dewards, SUM(camps_stacked) AS stacks,
           SUM(stuns) AS stuns, SUM(net_worth) AS net_worth, AVG(teamfight_participation) AS teamfight,
           SUM(duration) AS duration, SUM(rune_pickups) AS runes
    FROM player_matches
    WHERE season = @season AND (@role IS NULL OR role = @role)
    GROUP BY account_id`);
const namesStmt = db.prepare(`SELECT ps.account_id, ps.personaname, pa.avatar_url
    FROM player_stats ps LEFT JOIN player_avatars pa ON pa.account_id = ps.account_id WHERE ps.season = ?`);
const mvpStmt = db.prepare(`SELECT account_id, COUNT(*) AS c FROM match_mvps WHERE award_type = 'mvp' AND match_id >= ${SEASON_2_FIRST_MATCH} GROUP BY account_id`);
const resultsStmt = db.prepare(`SELECT account_id, won FROM player_matches WHERE season = ? ORDER BY account_id, start_time, match_id`);
const seasonMatchesStmt = db.prepare('SELECT COUNT(DISTINCT match_id) AS c, MAX(start_time) AS latest FROM player_matches WHERE season = ?');
// How the core/support split was decided, per match: 'lane' (OpenDota parsed
// lane data) vs 'heuristic' (wards/GPM fallback when a match wasn't parsed).
const roleSourceStmt = db.prepare(`SELECT role_source AS source, COUNT(DISTINCT match_id) AS c
    FROM player_matches WHERE season = ? AND role IS NOT NULL GROUP BY role_source`);
const mmrStmt = db.prepare(`
    SELECT mp.match_id, CAST(mp.discord_id AS TEXT) AS discord_id, mp.mmr, mp.team, m.winning_team, m.date_created,
           CAST(u.steam_id AS TEXT) AS steam_id, u.rating
    FROM match_players mp
    JOIN matches m ON m.match_id = mp.match_id
    LEFT JOIN users u ON CAST(u.discord_id AS TEXT) = CAST(mp.discord_id AS TEXT)
    WHERE mp.match_id >= ${SEASON_2_FIRST_MATCH} AND m.winning_team IS NOT NULL
    ORDER BY m.date_created, mp.match_id`);

const per = (sum, n) => (n > 0 ? sum / n : 0);
const perMin = (sum, seconds) => (seconds > 0 ? sum / (seconds / 60) : 0);

function buildRows(aggRows, names, valueFn, detailFn, minGames, { filter = null, desc = true } = {}) {
    return aggRows
        .filter(r => r.games >= minGames && (!filter || filter(r)))
        .map(r => ({
            accountId: r.account_id,
            name: names.get(r.account_id)?.name || 'Anonymous',
            avatar: names.get(r.account_id)?.avatar || null,
            games: r.games,
            value: valueFn(r),
            detail: detailFn ? detailFn(r) : null,
        }))
        .sort((a, b) => (desc ? b.value - a.value : a.value - b.value))
        .slice(0, 10);
}

function longestWinStreaks() {
    const streaks = new Map();
    let current = null, run = 0;
    for (const r of resultsStmt.all(CURRENT_SEASON)) {
        if (r.account_id !== current) { current = r.account_id; run = 0; }
        run = r.won ? run + 1 : 0;
        if (run > (streaks.get(current) || 0)) streaks.set(current, run);
    }
    return streaks;
}

// A single game moves a rating by at most ELO_K (K × (score − expected)), so a
// bigger step between two consecutive snapshots can only be a manual rating
// adjustment. Those steps are excluded from the climb and reported separately.
const ELO_K = Number(config.ELO_K) || 40;
const MAX_GAME_STEP = Math.ceil(ELO_K * 1.5);

function buildMmr(names, minGames) {
    const byDiscord = new Map();
    for (const r of mmrStmt.all()) {
        if (!byDiscord.has(r.discord_id)) {
            byDiscord.set(r.discord_id, { steamId: r.steam_id, rating: r.rating, rows: [] });
        }
        const t = Math.floor(new Date(r.date_created.replace(' ', 'T') + 'Z').getTime() / 1000);
        // team 0 = Radiant, 1 = Dire; winning_team 2 = Radiant, 3 = Dire
        const won = (r.team === 0 && r.winning_team === 2) || (r.team === 1 && r.winning_team === 3);
        byDiscord.get(r.discord_id).rows.push({ t, mmr: r.mmr, won });
    }
    const now = Math.floor(Date.now() / 1000);
    const players = [];
    for (const entry of byDiscord.values()) {
        if (!entry.steamId || entry.rating == null || entry.rows.length < minGames) continue;
        const accountId = accountIdFromSteam64(entry.steamId);
        if (accountId == null) continue;

        const rows = entry.rows;
        const startMmr = rows[0].mmr;
        let climb = 0;               // cumulative change from game results only
        let adjusted = 0;            // cumulative change attributed to manual adjustments
        const adjustments = [];
        const points = [{ t: rows[0].t, mmr: rows[0].mmr, delta: 0 }];
        const step = (prev, next, t) => {
            const d = next - prev;
            if (Math.abs(d) > MAX_GAME_STEP) { adjusted += d; adjustments.push({ t, amount: d }); }
            else climb += d;
        };
        for (let i = 1; i < rows.length; i++) {
            step(rows[i - 1].mmr, rows[i].mmr, rows[i].t);
            points.push({ t: rows[i].t, mmr: rows[i].mmr, delta: climb });
        }
        step(rows[rows.length - 1].mmr, entry.rating, now);
        points.push({ t: now, mmr: entry.rating, delta: climb });

        const wins = rows.filter(r => r.won).length;
        players.push({
            accountId,
            name: names.get(accountId)?.name || 'Anonymous',
            avatar: names.get(accountId)?.avatar || null,
            startMmr,
            currentMmr: entry.rating,
            gain: climb,                       // game-only climb (what the chart plots)
            rawGain: entry.rating - startMmr,  // including adjustments
            adjusted,
            adjustments,
            games: rows.length,
            wins,
            losses: rows.length - wins,
            points,
        });
    }
    players.sort((a, b) => b.gain - a.gain);
    const since = byDiscord.size ? Math.min(...[...byDiscord.values()].map(e => e.rows[0].t)) : null;
    return { since, minGames, maxGameStep: MAX_GAME_STEP, players: players.slice(0, 10), tracked: players.length };
}

function compute() {
    const names = new Map(namesStmt.all(CURRENT_SEASON).map(r => [r.account_id, { name: r.personaname, avatar: r.avatar_url }]));
    const seasonInfo = seasonMatchesStmt.get(CURRENT_SEASON);
    const all = aggStmt.all({ season: CURRENT_SEASON, role: null });
    const core = aggStmt.all({ season: CURRENT_SEASON, role: 'core' });
    const support = aggStmt.all({ season: CURRENT_SEASON, role: 'support' });

    // Rolling qualification bar (sqrt of season games, at least 2). Role boards
    // use the same bar, counted in games played in that role.
    const totalSeasonMatches = Math.max(seasonInfo.c || 0, all.reduce((m, r) => Math.max(m, r.games), 0));
    const minMatches = Math.max(2, Math.ceil(Math.sqrt(totalSeasonMatches)));
    const minRoleMatches = minMatches;
    const mvps = new Map(mvpStmt.all().map(r => [r.account_id, r.c]));
    const streaks = longestWinStreaks();

    const wl = r => `${r.wins}–${r.games - r.wins}`;
    const kda = r => (r.deaths > 0 ? (r.kills + r.assists) / r.deaths : r.kills + r.assists);

    const overview = [
        { key: 'winrate', title: 'Win Rate', subtitle: 'Best win/loss ratio', format: 'percent',
          rows: buildRows(all, names, r => r.wins / r.games, wl, minMatches) },
        { key: 'mmr', title: 'Biggest MMR Climb', subtitle: 'Most Garg MMR gained this season', format: 'signed', chart: true, rows: [] },
        { key: 'kda', title: 'K/D/A', subtitle: 'Kills + assists per death', format: 'decimal2',
          rows: buildRows(all, names, kda, r => `${Math.round(per(r.kills, r.games))} / ${Math.round(per(r.deaths, r.games))} / ${Math.round(per(r.assists, r.games))} avg`, minMatches) },
        { key: 'mvp', title: 'League MVP', subtitle: 'Most match MVP awards', format: 'integer',
          rows: buildRows(all, names, r => mvps.get(r.account_id) || 0, r => `${r.wins} wins`, 1, { filter: r => (mvps.get(r.account_id) || 0) > 0 }) },
        { key: 'streak', title: 'On a Heater', subtitle: 'Longest win streak', format: 'integer',
          rows: buildRows(all, names, r => streaks.get(r.account_id) || 0, wl, minMatches, { filter: r => (streaks.get(r.account_id) || 0) >= 2 }) },
        { key: 'grinder', title: 'The Grinder', subtitle: 'Most games played', format: 'integer',
          rows: buildRows(all, names, r => r.games, wl, 1) },
        { key: 'gpm', title: 'Gold Per Minute', subtitle: 'Average GPM', format: 'integer',
          rows: buildRows(all, names, r => per(r.gpm, r.games), r => `${Math.round(per(r.net_worth, r.games)).toLocaleString()} avg net worth`, minMatches) },
        { key: 'midas', title: 'Midas Score', subtitle: 'Most net worth with least fight participation', format: 'integer',
          rows: buildRows(all, names, r => per(r.net_worth, r.games) / (per(r.kills, r.games) + per(r.assists, r.games) + 1),
              r => `${(per(r.kills, r.games) + per(r.assists, r.games)).toFixed(1)} K+A per game`, minMatches) },
    ];

    const coreCats = [
        { key: 'core-winrate', title: 'Core Win Rate', subtitle: 'Best record when playing a core role', format: 'percent',
          rows: buildRows(core, names, r => r.wins / r.games, wl, minRoleMatches) },
        { key: 'farm', title: 'Farm Machine', subtitle: 'Last hits per minute', format: 'decimal1',
          rows: buildRows(core, names, r => perMin(r.last_hits, r.duration), r => `${Math.round(per(r.last_hits, r.games))} LH per game`, minRoleMatches) },
        { key: 'damage', title: 'Heavy Hitter', subtitle: 'Hero damage per minute', format: 'integer',
          rows: buildRows(core, names, r => perMin(r.hero_damage, r.duration), r => `${Math.round(per(r.hero_damage, r.games)).toLocaleString()} per game`, minRoleMatches) },
        { key: 'towers', title: 'Tower Terrorist', subtitle: 'Average tower damage per game', format: 'integer',
          rows: buildRows(core, names, r => per(r.tower_damage, r.games), r => `${r.games} core games`, minRoleMatches) },
        { key: 'denies', title: 'Deny Enjoyer', subtitle: 'Average denies per game', format: 'decimal1',
          rows: buildRows(core, names, r => per(r.denies, r.games), r => `${Math.round(per(r.last_hits, r.games))} LH per game`, minRoleMatches) },
        { key: 'networth', title: 'Big Bank', subtitle: 'Average net worth at game end', format: 'integer',
          rows: buildRows(core, names, r => per(r.net_worth, r.games), r => `${Math.round(per(r.gpm, r.games))} GPM`, minRoleMatches) },
        { key: 'core-kda', title: 'Core K/D/A', subtitle: 'Kills + assists per death as a core', format: 'decimal2',
          rows: buildRows(core, names, kda, wl, minRoleMatches) },
    ];

    const supportCats = [
        { key: 'support-winrate', title: 'Support Win Rate', subtitle: 'Best record when playing a support role', format: 'percent',
          rows: buildRows(support, names, r => r.wins / r.games, wl, minRoleMatches) },
        { key: 'wards', title: 'Ward Lord', subtitle: 'Wards placed per game (observers + sentries)', format: 'decimal1',
          rows: buildRows(support, names, r => per(r.wards, r.games), r => `${r.wards} total`, minRoleMatches) },
        { key: 'dewards', title: 'True Sight', subtitle: 'Enemy observer wards destroyed per game', format: 'decimal2',
          rows: buildRows(support, names, r => per(r.dewards, r.games), r => `${r.dewards} total`, minRoleMatches, { filter: r => r.dewards > 0 }) },
        { key: 'stacks', title: 'Camp Counselor', subtitle: 'Neutral camps stacked per game', format: 'decimal1',
          rows: buildRows(support, names, r => per(r.stacks, r.games), r => `${r.stacks} total`, minRoleMatches, { filter: r => r.stacks > 0 }) },
        { key: 'stuns', title: 'Lockdown', subtitle: 'Seconds of stun per game', format: 'decimal1',
          rows: buildRows(support, names, r => per(r.stuns, r.games), r => `${Math.round(r.stuns)}s total`, minRoleMatches, { filter: r => r.stuns > 0 }) },
        { key: 'healing', title: 'Medic', subtitle: 'Hero healing per game', format: 'integer',
          rows: buildRows(support, names, r => per(r.hero_healing, r.games), r => `${r.games} support games`, minRoleMatches, { filter: r => r.hero_healing > 0 }) },
        { key: 'teamfight', title: 'Glue', subtitle: 'Teamfight participation', format: 'percent',
          rows: buildRows(support, names, r => r.teamfight || 0, r => `${r.games} support games`, minRoleMatches, { filter: r => r.teamfight != null }) },
        { key: 'support-kda', title: 'Support K/D/A', subtitle: 'Kills + assists per death as a support', format: 'decimal2',
          rows: buildRows(support, names, kda, wl, minRoleMatches) },
    ];

    const mmr = buildMmr(names, Math.max(3, Math.min(minMatches, 5)));
    // The overview "Biggest MMR Climb" card mirrors the MMR tab's top 10.
    overview[1].rows = mmr.players.map(p => ({
        accountId: p.accountId, name: p.name, avatar: p.avatar, games: p.games,
        value: p.gain, detail: `${p.wins}–${p.losses}${p.adjusted ? ` · ${p.adjusted > 0 ? '+' : ''}${p.adjusted} adjusted` : ''}`,
    }));

    return {
        season: CURRENT_SEASON,
        lastUpdated: playerStatsCache.lastFetched || Date.now(),
        cacheMaxAge: PLAYER_STATS_TTL_MS,
        matchesAnalyzed: totalSeasonMatches,
        latestMatch: seasonInfo.latest || null,
        minMatches,
        minRoleMatches,
        rolesAvailable: core.length > 0,
        roleSource: Object.fromEntries(roleSourceStmt.all(CURRENT_SEASON).map(r => [r.source || 'unknown', r.c])),
        tabs: {
            overview: { label: 'Overview', categories: overview },
            core: { label: 'Core', categories: coreCats },
            support: { label: 'Support', categories: supportCats },
        },
        mmr,
    };
}

export function mountRankingsRoutes(server) {
    server.get('/api/rankings', (req, res) => {
        try {
            if (!cache.data || Date.now() - cache.at > CACHE_MS) {
                cache = { data: compute(), at: Date.now() };
            }
            return res.json(cache.data);
        } catch (err) {
            logger.error(`[Rankings] failed to compute: ${err.message}`);
            return res.status(500).json({ error: 'Failed to compute rankings' });
        }
    });
}
