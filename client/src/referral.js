// Hidden referral tracking for registration links.
//
// A promo link such as https://www.gargamel-league.com/?ref=reddit carries a
// short source tag. When the app loads we pull the tag out of the URL, stash it
// in the browser, and rewrite the address bar so the visitor never sees it.
// Later, when they register (home page or profile "Link Steam"), the tag rides
// along to the server and lands in users.referral_source for mods to see.
// Nothing on the page ever displays it.

const STORAGE_KEY = 'gl_ref';
const PARAM = 'ref';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // a visitor from Reddit who registers within a month still counts

// Lower-case slug, at most 32 chars; mirrors the server's normaliser.
export function normalizeReferralSource(raw) {
    if (typeof raw !== 'string') return null;
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    return slug || null;
}

// Call once on app load. Returns the captured tag (or null).
export function captureReferralSource() {
    let source = null;
    try {
        const url = new URL(window.location.href);
        source = normalizeReferralSource(url.searchParams.get(PARAM));
        if (url.searchParams.has(PARAM)) {
            url.searchParams.delete(PARAM);
            window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
        }
    } catch (_) { /* malformed URL: nothing to capture */ }
    if (source) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ source, at: Date.now() }));
        } catch (_) { /* storage blocked: the tag only lives for this page load */ }
        lastCaptured = source;
    }
    return source;
}

let lastCaptured = null;

// The stored tag, or null when none was captured or it has expired.
export function getReferralSource() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const { source, at } = JSON.parse(raw);
            if (Date.now() - (at || 0) < TTL_MS) return normalizeReferralSource(source);
            window.localStorage.removeItem(STORAGE_KEY);
        }
    } catch (_) { /* fall through to the in-memory copy */ }
    return lastCaptured;
}

// Forget the tag once a registration has been submitted with it.
export function clearReferralSource() {
    lastCaptured = null;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
}
