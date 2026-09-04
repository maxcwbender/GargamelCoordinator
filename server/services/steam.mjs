import fetch from 'node-fetch';
import { logger } from '../logger.mjs';
import { STEAM_API_BASE, STEAM_API_KEY, LEAGUE_ID } from '../config.mjs';

export let liveGameCache = {
    data: null,
    lastFetched: 0,
    isActive: false,
    gameCount: 0
};

// ─── Steam API: Fetch Live Games ─────────────────────────────────────────────
export async function fetchLiveGame() {
    const startTime = Date.now();
    logger.info('[LiveGame] Starting Steam API fetch...');

    try {
        const url = `${STEAM_API_BASE}/IDOTA2Match_570/GetLiveLeagueGames/v0001/?key=${STEAM_API_KEY}&league_id=${LEAGUE_ID}`;

        const response = await fetch(url, { timeout: 10000 });
        const elapsed = Date.now() - startTime;
        logger.info(`[LiveGame] Steam API responded in ${elapsed}ms with status ${response.status}`);

        if (!response.ok) {
            logger.error(`[LiveGame] Steam API error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const games = data?.result?.games || [];
        logger.info(`[LiveGame] Found ${games.length} total live games across ALL leagues`);

        // Filter to our league only — return ALL matching games
        const ourGames = games.filter(g => g.league_id === LEAGUE_ID);
        logger.info(`[LiveGame] Looking for league_id=${LEAGUE_ID}, found ${ourGames.length} game(s)`);

        return ourGames;
    } catch (error) {
        const elapsed = Date.now() - startTime;
        logger.error(`[LiveGame] Failed after ${elapsed}ms:`, error.message || error);
        return [];
    }
}
