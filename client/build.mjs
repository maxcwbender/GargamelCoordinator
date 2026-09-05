// Production build for the React frontend. Output goes to client/dist, which is
// the ONLY directory the server ever serves statically (see server/static.mjs).
//
//   dist/index.html      — app shell (copied from index.html)
//   dist/assets/app.js   — bundled, minified React app
//   dist/assets/app.css  — bundled styles
//   dist/<public files>  — static assets copied verbatim from client/public/
//
// Never put secrets anywhere under client/ — everything that ends up in dist is
// public. scripts/scan-dist.mjs verifies that after every build.

import { build } from 'esbuild';
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'assets'), { recursive: true });

await build({
    entryPoints: [join(HERE, 'src', 'main.jsx')],
    bundle: true,
    minify: true,
    jsx: 'automatic',
    target: ['es2019'],
    define: { 'process.env.NODE_ENV': '"production"' },
    // Absolute-path url() assets (e.g. /minimap_background.png) are served from
    // dist/ at runtime, not bundled.
    external: ['/*.png', '/*.ico'],
    outfile: join(DIST, 'assets', 'app.js'),
    logLevel: 'info',
});

copyFileSync(join(HERE, 'index.html'), join(DIST, 'index.html'));

const PUBLIC = join(HERE, 'public');
if (existsSync(PUBLIC)) {
    cpSync(PUBLIC, DIST, { recursive: true });
}

// The live minimap overlays structures on this image; without it the map is
// a black square. It must live in client/public so every build ships it.
if (!existsSync(join(PUBLIC, 'minimap_background.png'))) {
    console.warn('WARNING: client/public/minimap_background.png is missing — the live minimap will have no background.');
}

console.log('Build complete: client/dist');
