// Small shared UI pieces used across the data pages.
import { Link } from '../router.jsx';

export function Spinner({ label }) {
    return (
        <div className="loading-spinner">
            <div className="spinner-ring"></div>
            <div>{label}</div>
        </div>
    );
}

export function ErrorBox({ message, onRetry }) {
    return (
        <div className="error-state">
            <p>{message}</p>
            <button className="retry-btn" onClick={onRetry}>Retry</button>
        </div>
    );
}

export function EmptyState({ title, children }) {
    return (
        <div className="empty-state">
            <h2>{title}</h2>
            <p>{children}</p>
        </div>
    );
}

// Player name linking to their league profile, with a small separate arrow
// that opens their OpenDota page. Plain text when the player is anonymous.
export function PlayerLink({ name, accountId, opendota = true }) {
    if (!accountId) return <>{name}</>;
    return (
        <span className="player-link">
            <Link to={`/players/${accountId}`} title="View league profile">{name}</Link>
            {opendota && (
                <a
                    className="od-link"
                    href={`https://www.opendota.com/players/${accountId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on OpenDota"
                    onClick={e => e.stopPropagation()}
                >↗</a>
            )}
        </span>
    );
}
