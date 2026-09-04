import { logger } from '../logger.mjs';
import { CACHE_TTL_MS, PLAYER_STATS_TTL_MS, LIVE_GAME_CACHE_TTL } from '../config.mjs';
import {
    matchCache, playerStatsCache, isRefreshingStats,
    refreshMatchCache, refreshPlayerStats, dotaConstants,
} from '../services/opendota.mjs';
import { liveGameCache, fetchLiveGame } from '../services/steam.mjs';

// Matches, rankings, and live-game endpoints (all public, cached league data).
export function mountLeagueRoutes(server) {
    server.get('/api/recent-matches', async (req, res) => {
        // Refresh cache if stale
        if (Date.now() - matchCache.lastFetched > CACHE_TTL_MS) {
            await refreshMatchCache();
        }
        // Filter out debug matches (less than 10 players)
        const fullMatches = (matchCache.data || []).filter(match => {
            const playerCount = match.players?.length || 0;
            return playerCount >= 10;
        });
        return res.json({
            matches: fullMatches,
            lastUpdated: matchCache.lastFetched,
            cacheMaxAge: CACHE_TTL_MS,
        });
    });

    server.post('/api/refresh-matches', async (_req, res) => {
        logger.info('Manual match cache refresh triggered via API');
        await refreshMatchCache();
        return res.json({ status: 'refreshed', lastUpdated: matchCache.lastFetched });
    });

    server.post('/api/refresh-rankings', async (req, res) => {
        if (isRefreshingStats()) {
            return res.json({ status: 'already_refreshing' });
        }
        logger.info('Manual rankings refresh triggered via API');
        refreshPlayerStats();
        return res.json({ status: 'refresh_started' });
    });

    server.get('/api/top-rankings', async (req, res) => {
        // Don't refresh if already refreshing
        if (!isRefreshingStats() && Date.now() - playerStatsCache.lastFetched > PLAYER_STATS_TTL_MS) {
            // Trigger refresh in background, don't wait for it
            refreshPlayerStats();
        }

        const players = playerStatsCache.data || [];

        // Rolling qualification bar: scales with the length of the season so a player
        // with only a handful of games can't top the board on a tiny sample.
        // "Season games" = the most games any single player has played. This equals the
        // distinct Season 2 match count when the most-active player attends every game,
        // and is a safe lower bound otherwise. Taking the max with the cached
        // matchesAnalyzed keeps the bar from collapsing if that value is ever stale/empty.
        const mostGamesPlayed = players.reduce((max, p) => Math.max(max, p.matches), 0);
        const totalSeasonMatches = Math.max(playerStatsCache.matchesAnalyzed || 0, mostGamesPlayed);
        const minMatches = Math.max(2, Math.ceil(Math.sqrt(totalSeasonMatches)));
        const qualified = players.filter(p => p.matches >= minMatches);

        const topByWinRate = [...qualified]
            .sort((a, b) => b.winRate - a.winRate)
            .slice(0, 10);

        const topByKDA = [...qualified]
            .sort((a, b) => b.kda - a.kda)
            .slice(0, 10);

        const topByGPM = [...qualified]
            .sort((a, b) => b.avgGPM - a.avgGPM)
            .slice(0, 10);

        const topByWards = [...qualified]
            .sort((a, b) => b.avgWards - a.avgWards)
            .slice(0, 10);

        // Top 10 dewarders (by avg observer wards killed per game)
        const topByDewards = [...qualified]
            .filter(p => p.observer_kills > 0)
            .sort((a, b) => b.avgDewards - a.avgDewards)
            .slice(0, 10);

        // "Hand of Midas, Heart of Absence" - highest net worth per fight participation.
        // Score = avgNetWorth / (avgKills + avgAssists + 1)
        // The +1 prevents division by zero and slightly penalises zero participation.
        const topByMidas = [...qualified]
            .map(p => ({
                ...p,
                midasScore: p.avgNetWorth / (p.avgKills + p.avgAssists + 1),
            }))
            .sort((a, b) => b.midasScore - a.midasScore)
            .slice(0, 10);

        // Player of the Month — most MVP awards (no minimum-match filter; MVPs already require wins)
        const playerOfTheMonth = [...players]
            .filter(p => p.mvpCount > 0)
            .sort((a, b) => b.mvpCount - a.mvpCount || b.svpCount - a.svpCount)
            .slice(0, 1)[0] || null;

        return res.json({
            topByWinRate,
            topByKDA,
            topByGPM,
            topByWards,
            topByDewards,
            topByMidas,
            playerOfTheMonth,
            minMatchesRequired: minMatches,
            lastUpdated: playerStatsCache.lastFetched,
            matchesAnalyzed: totalSeasonMatches,
            cacheMaxAge: PLAYER_STATS_TTL_MS,
        });
    });

    server.get('/api/live-game', async (req, res) => {
        const requestStart = Date.now();

        // Helper: resolve item ID to { name, img } or null
        function resolveItem(id) {
            if (!id || id === 0) return null;
            const item = dotaConstants.items[id];
            return item ? { id, name: item.name, img: item.img } : { id, name: 'Unknown', img: null };
        }

        // Helper: transform a single raw game into frontend format
        function transformGameData(game) {
            const radiantPlayerList = game.scoreboard.radiant.players || [];
            const direPlayerList = game.scoreboard.dire.players || [];

            function transformPlayer(p, team) {
                const playerInfo = (game.players || []).find(pl => pl.account_id === p.account_id);
                const hero = dotaConstants.heroes[playerInfo?.hero_id];
                return {
                    accountId: p.account_id,
                    name: playerInfo?.name || 'Unknown',
                    heroId: playerInfo?.hero_id,
                    heroName: hero?.name || null,
                    heroImg: hero?.img || null,
                    team,
                    kills: p.kills || 0,
                    deaths: p.death || 0,
                    assists: p.assists || 0,
                    lastHits: p.last_hits || 0,
                    denies: p.denies || 0,
                    gpm: p.gold_per_min || 0,
                    xpm: p.xp_per_min || 0,
                    netWorth: p.net_worth || 0,
                    level: p.level || 1,
                    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map(resolveItem),
                    posX: p.position_x,
                    posY: p.position_y,
                    respawnTimer: p.respawn_timer || 0
                };
            }

            return {
                matchId: game.match_id,
                duration: game.scoreboard.duration || 0,
                spectators: game.spectators || 0,
                radiant: {
                    score: game.scoreboard.radiant.score || 0,
                    towerState: game.scoreboard.radiant.tower_state || 0,
                    barracksState: game.scoreboard.radiant.barracks_state || 0,
                    players: radiantPlayerList.map(p => transformPlayer(p, 'radiant'))
                },
                dire: {
                    score: game.scoreboard.dire.score || 0,
                    towerState: game.scoreboard.dire.tower_state || 0,
                    barracksState: game.scoreboard.dire.barracks_state || 0,
                    players: direPlayerList.map(p => transformPlayer(p, 'dire'))
                }
            };
        }

        try {
            const now = Date.now();

            // Return cached data if still fresh
            if (liveGameCache.data && (now - liveGameCache.lastFetched) < LIVE_GAME_CACHE_TTL) {
                return res.json(liveGameCache.data);
            }

            const rawGames = await fetchLiveGame();
            liveGameCache.lastFetched = Date.now();
            liveGameCache.isActive = rawGames.length > 0;
            liveGameCache.gameCount = rawGames.length;

            if (rawGames.length === 0) {
                liveGameCache.data = { active: false, gameCount: 0, games: [], pendingGames: [] };
                return res.json(liveGameCache.data);
            }

            const transformedGames = [];
            const pendingGames = [];

            for (const game of rawGames) {
                // Defensive checks for game structure
                if (!game.scoreboard || !game.scoreboard.radiant || !game.scoreboard.dire) {
                    logger.warn(`[API /api/live-game] Game match_id=${game.match_id} missing scoreboard data (picking phase?)`);
                    pendingGames.push({ pending: true, matchId: game.match_id });
                    continue;
                }

                transformedGames.push(transformGameData(game));
            }

            liveGameCache.data = {
                active: transformedGames.length > 0,
                gameCount: transformedGames.length,
                games: transformedGames,
                pendingGames: pendingGames
            };

            const elapsed = Date.now() - requestStart;
            logger.info(`[API /api/live-game] Success, responding in ${elapsed}ms`);
            return res.json(liveGameCache.data);

        } catch (error) {
            const elapsed = Date.now() - requestStart;
            logger.error(`[API /api/live-game] ERROR after ${elapsed}ms:`, error.message || error);
            logger.error('[API /api/live-game] Stack:', error.stack);
            // Return inactive rather than crashing
            return res.json({ active: false, gameCount: 0, games: [], pendingGames: [], error: 'server_error' });
        }
    });

    server.get('/api/live-game/status', async (req, res) => {
        try {
            const now = Date.now();

            // Use cached status if recent
            if ((now - liveGameCache.lastFetched) < LIVE_GAME_CACHE_TTL) {
                return res.json({ active: liveGameCache.isActive, gameCount: liveGameCache.gameCount || 0 });
            }

            const games = await fetchLiveGame();
            liveGameCache.isActive = games.length > 0;
            liveGameCache.gameCount = games.length;
            liveGameCache.lastFetched = now;

            return res.json({ active: games.length > 0, gameCount: games.length });
        } catch (error) {
            logger.error('[API /api/live-game/status] ERROR:', error.message || error);
            return res.json({ active: false, gameCount: 0, error: 'server_error' });
        }
    });
}
