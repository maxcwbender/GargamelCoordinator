// Shared formatting helpers (ported verbatim from the old per-page scripts).

export function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
}

export function timeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
}

export function formatMatchDate(timestamp) {
    const date = new Date(timestamp * 1000); // Unix timestamp -> ms
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (hours < 24) {
        if (hours < 1) return 'Less than an hour ago';
        return hours === 1 ? '1 hour ago' : hours + ' hours ago';
    }
    if (days < 7) {
        return days === 1 ? 'Yesterday' : days + ' days ago';
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const formatPercent = (decimal) => (decimal * 100).toFixed(1) + '%';

export const GAME_MODES = {
    0: 'Unknown', 1: 'All Pick', 2: "Captain's Mode", 3: 'Random Draft',
    4: 'Single Draft', 5: 'All Random', 6: 'Intro', 7: 'Diretide',
    8: 'Greeviling', 9: 'Tutorial', 10: 'Mid Only', 11: 'Least Played',
    12: 'Limited Heroes', 13: 'Compendium', 14: 'All Pick', 15: 'Custom',
    16: "Captain's Draft", 17: 'Balanced Draft', 18: 'Ability Draft',
    19: 'Event', 20: 'All Random DM', 21: '1v1 Mid', 22: 'All Draft',
    23: 'Turbo', 24: 'Mutation'
};
