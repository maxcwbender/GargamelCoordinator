// Synthetic profile fixtures for /profile?demo=1 — lets the account pages be
// exercised without a real Discord login or league data. Shapes match what
// /api/profile/me and /api/players/:id/profile return.

const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';
export const DEMO_HEROES = [
    { id: 14, name: 'Pudge', img: `${CDN}/pudge.png` },
    { id: 74, name: 'Invoker', img: `${CDN}/invoker.png` },
    { id: 1, name: 'Anti-Mage', img: `${CDN}/antimage.png` },
    { id: 5, name: 'Crystal Maiden', img: `${CDN}/crystal_maiden.png` },
    { id: 8, name: 'Juggernaut', img: `${CDN}/juggernaut.png` },
    { id: 26, name: 'Lion', img: `${CDN}/lion.png` },
    { id: 11, name: 'Shadow Fiend', img: `${CDN}/nevermore.png` },
    { id: 2, name: 'Axe', img: `${CDN}/axe.png` },
];
export const heroById = (id, heroes = DEMO_HEROES) =>
    heroes.find(h => h.id === Number(id)) || { id: Number(id), name: `Hero #${id}`, img: null };

export const DEMO_VETO_MODES = [
    { id: 2, label: 'Captains Mode' }, { id: 3, label: 'Random Draft' }, { id: 4, label: 'Single Draft' },
    { id: 5, label: 'All Random' }, { id: 12, label: 'Least Played' }, { id: 16, label: "Captain's Draft" },
    { id: 18, label: 'Ability Draft' }, { id: 22, label: 'Ranked All Pick' }, { id: 23, label: 'Turbo' },
];

export const DEMO_DEFAULT_OPTIONS = {
    viewer: 'owner',      // 'owner' | 'visitor'
    linked: true,         // Steam linked in the users table
    hasStats: true,       // has Season games
    hasPrefs: true,       // favorite heroes / position / veto set
    hasAccount: true,     // has logged into the website before (Discord identity known)
};

export const DEMO_ACCOUNT_ID = 123456789;

// Build a profile payload from the option toggles. `prefs` overrides the
// preference block (used after a simulated save).
export function buildDemoProfile(opts = DEMO_DEFAULT_OPTIONS, prefs = null) {
    const o = { ...DEMO_DEFAULT_OPTIONS, ...opts };
    const now = Math.floor(Date.now() / 1000);
    const linked = !!o.linked;
    const stats = linked && o.hasStats;

    const prefBlock = prefs || (o.hasPrefs ? {
        favHeroes: [heroById(14), heroById(74), heroById(26)],
        favPosition: 'hard_support',
        vetoMode: DEMO_VETO_MODES.find(m => m.id === 23),
    } : { favHeroes: [], favPosition: null, vetoMode: null });

    return {
        accountId: linked ? DEMO_ACCOUNT_ID : null,
        displayName: o.hasAccount ? 'DemoPlayer' : (stats ? 'SmurfHunter' : 'Unknown Player'),
        steamName: linked ? 'SmurfHunter' : null,
        discordName: o.hasAccount ? 'demoplayer' : null,
        discordAvatar: o.hasAccount ? 'https://cdn.discordapp.com/embed/avatars/3.png' : null,
        hasAccount: !!o.hasAccount,
        steam: {
            linked,
            avatar: null, // real profiles get the OpenDota-cached Steam avatar; the demo shows the placeholder
            profileUrl: linked ? 'https://steamcommunity.com/profiles/76561197960265728' : null,
        },
        opendotaUrl: linked ? `https://www.opendota.com/players/${DEMO_ACCOUNT_ID}` : null,
        season: stats ? {
            number: 2, wins: 18, losses: 9, matches: 27, kda: 3.42, avgGPM: 486, mvpCount: 3, svpCount: 1,
        } : null,
        topHeroes: stats ? [
            { ...heroById(14), games: 9, wins: 6, losses: 3 },
            { ...heroById(74), games: 6, wins: 4, losses: 2 },
            { ...heroById(1), games: 4, wins: 1, losses: 3 },
        ] : [],
        bestAllies: stats ? [
            { accountId: 1001, name: 'WardGoblin', avatar: null, games: 9, wins: 7, losses: 2 },
            { accountId: 1002, name: 'MidOrFeed', avatar: null, games: 6, wins: 5, losses: 1 },
            { accountId: 1003, name: 'CarryPotential', avatar: null, games: 8, wins: 5, losses: 3 },
            { accountId: 1004, name: 'JungleLifestyle', avatar: null, games: 5, wins: 3, losses: 2 },
            { accountId: 1005, name: 'TiltedTed', avatar: null, games: 4, wins: 2, losses: 2 },
        ] : [],
        recentMatches: stats ? [14, 74, 1, 5, 8, 26, 11, 2, 14, 74].map((heroId, n) => ({
            matchId: 8800000000 + n,
            hero: heroById(heroId),
            won: n % 2 === 0,
            kills: 7 + n, deaths: 3, assists: 12,
            gpm: 500 - n * 10,
            startTime: now - n * 86400 - 3600,
            duration: 2100 + n * 60,
            gameMode: 22,
        })) : [],
        prefs: prefBlock,
        isOwner: o.viewer === 'owner',
    };
}
