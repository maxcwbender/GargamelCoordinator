import { useEffect, useState } from 'react';
import { useRouter } from '../router.jsx';

const POLL_INTERVAL = 15000; // Check every 15 seconds
const DISMISSED_KEY = 'liveGameToastDismissed';
const DISMISS_DURATION = 5 * 60 * 1000; // 5 minutes

// Floating "Live Game in Progress" toast, shown on every page except the live
// game page itself. Dismissal is remembered for 5 minutes via localStorage.
export default function LiveGameToast() {
    const { path, navigate } = useRouter();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function check() {
            if (window.location.pathname === '/livegame') return;
            try {
                const dismissed = localStorage.getItem(DISMISSED_KEY);
                if (dismissed && (Date.now() - parseInt(dismissed)) < DISMISS_DURATION) return;
            } catch { /* storage unavailable */ }

            try {
                const res = await fetch('/api/live-game/status');
                const data = await res.json();
                if (cancelled) return;
                if (data.active) {
                    setVisible(true);
                } else {
                    setVisible(false);
                    try { localStorage.removeItem(DISMISSED_KEY); } catch {}
                }
            } catch (err) {
                console.error('Failed to check live game status:', err);
            }
        }

        check();
        const timer = setInterval(check, POLL_INTERVAL);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    if (!visible || path === '/livegame') return null;

    const dismiss = (e) => {
        e.stopPropagation();
        try { localStorage.setItem(DISMISSED_KEY, Date.now().toString()); } catch {}
        setVisible(false);
    };

    return (
        <div className="live-toast" onClick={() => navigate('/livegame')}>
            <div className="live-toast-content">
                <div className="live-toast-icon">🔴</div>
                <div className="live-toast-message">
                    <strong>Live Game in Progress!</strong>
                    <p>Click to watch</p>
                </div>
                <button className="live-toast-close" onClick={dismiss}>&times;</button>
            </div>
        </div>
    );
}
