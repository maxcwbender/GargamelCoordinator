import express from 'express';
import { existsSync } from 'fs';
import { join, resolve, sep } from 'path';
import { ROOT } from './config.mjs';
import { logger } from './logger.mjs';

// ─── Static file safety ──────────────────────────────────────────────────────
// HISTORY: this server once used express.static('.') and leaked config.json
// (bot token and all) to the open internet, where it sat indexed by leakix for
// two weeks. The rules below exist so that can never happen again:
//
//   1. The ONLY static root is client/dist — the React build output. Nothing
//      else in the repo is ever handed to express.static.
//   2. assertSafeStaticRoot() refuses to boot the static layer if the root
//      looks wrong: not under the repo, is the repo root itself, or contains
//      anything secret-shaped (config.json, .env, *.db). A bad refactor fails
//      loudly at startup instead of quietly serving secrets.
//   3. The SPA fallback serves one fixed file (dist/index.html) and never
//      touches the request path, so there is nothing to traverse.
//   4. Requests for paths that look like files (have an extension) are NOT
//      given the SPA fallback — they 404. That keeps probes like GET
//      /config.json answering 404 instead of 200-with-index.html, which is
//      what scripts/safety-check.mjs asserts after every deploy.

const FORBIDDEN_IN_ROOT = ['config.json', '.env', 'allUsers.db', 'index.mjs', 'Master_Bot.py', '.git'];

function assertSafeStaticRoot(dir) {
    const abs = resolve(dir);
    const repoRoot = resolve(ROOT);
    if (!abs.startsWith(repoRoot + sep)) {
        throw new Error(`Static root ${abs} is outside the repo — refusing to serve it`);
    }
    if (abs === repoRoot) {
        throw new Error('Static root is the repo root — refusing to serve secrets. Static must point at client/dist only.');
    }
    for (const name of FORBIDDEN_IN_ROOT) {
        if (existsSync(join(abs, name))) {
            throw new Error(`Static root ${abs} contains ${name} — refusing to serve it. Static must point at the React build output only.`);
        }
    }
    return abs;
}

// Path segments like "app.js" or "logo.png" — used to deny the SPA fallback to
// file-looking requests so missing files 404 instead of returning index.html.
const looksLikeFile = (path) => /\.[a-zA-Z0-9]{1,8}$/.test(path.split('?')[0]);

export function mountStatic(server) {
    const distDir = assertSafeStaticRoot(join(ROOT, 'client', 'dist'));
    const indexHtml = join(distDir, 'index.html');
    const built = existsSync(indexHtml);

    if (!built) {
        logger.warn(`No frontend build found at ${indexHtml} — API stays up, pages will show a build notice. Run: npm run build`);
    } else {
        logger.info(`Serving frontend from ${distDir}`);
    }

    server.use(express.static(distDir, {
        dotfiles: 'ignore',
        index: false,
        // Assets revalidate via ETag (cheap 304s); bundle names are stable so
        // never let browsers cache them blindly across deploys.
        etag: true,
        cacheControl: true,
        maxAge: 0,
    }));

    // SPA fallback: every remaining GET that isn't an API call and doesn't look
    // like a file request gets the app shell; client-side routing takes it from
    // there. The served path is a constant — request input is never used.
    server.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        if (looksLikeFile(req.path)) return next();
        if (!existsSync(indexHtml)) {
            return res.status(503).type('text/plain').send('Frontend not built yet. Run: npm run build');
        }
        return res.sendFile(indexHtml);
    });
}
