// Small shared UI pieces used across the data pages.

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

// Player name linking to their OpenDota profile (plain text when anonymous).
export function PlayerLink({ name, accountId }) {
    if (!accountId) return <>{name}</>;
    return (
        <a href={`https://www.opendota.com/players/${accountId}`} target="_blank" rel="noopener noreferrer">
            {name}
        </a>
    );
}
