import express from 'express';
import { logger } from './logger.mjs';
import { startOpenDotaBackgroundWork } from './services/opendota.mjs';
import { startDiscordBackgroundWork } from './services/discord.mjs';
import { mountLeagueRoutes } from './routes/league.mjs';
import { mountRegisterRoutes } from './routes/register.mjs';
import { mountPlanningRoutes } from './routes/planning.mjs';
import { mountAuthRoutes } from './routes/auth.mjs';
import { mountProfileRoutes } from './routes/profile.mjs';
import { mountRankingsRoutes } from './routes/rankings.mjs';
import { mountStatic } from './static.mjs';

const server = express();
server.use(express.json());

// CORS (kept permissive, matching the previous behavior)
server.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// API routes first, then the static frontend + SPA fallback.
mountLeagueRoutes(server);
mountRegisterRoutes(server);
mountPlanningRoutes(server);
mountAuthRoutes(server);
mountProfileRoutes(server);
mountRankingsRoutes(server);
mountStatic(server);

// Background caches (OpenDota crawl, Discord members) start after the routes are
// wired so server.listen isn't blocked — the landing page must come up instantly
// even while the first ~15s match crawl is still running.
startOpenDotaBackgroundWork();
startDiscordBackgroundWork();

// ─── Global Error Handlers ───────────────────────────────────────────────────
process.on('uncaughtException', (error) => {
    logger.error('[FATAL] Uncaught Exception:', error.message);
    logger.error('[FATAL] Stack:', error.stack);
    // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason) => {
    logger.error('[FATAL] Unhandled Promise Rejection:', reason);
    if (reason instanceof Error) {
        logger.error('[FATAL] Stack:', reason.stack);
    }
    // Don't exit - try to keep running
});

server.listen(3000, '0.0.0.0', () => logger.info('Server listening at http://localhost:3000'));
