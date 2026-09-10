import { useCallback, useEffect, useState } from 'react';
import { Link } from '../router.jsx';
import { Spinner, ErrorBox, EmptyState } from '../components/shared.jsx';
import { MatchCard } from './Matches.jsx';

// /players/:id/mvps — every Season match where the player won MVP, shown with
// the same match cards as the Matches page (the ★ marks them).
export default function PlayerMvps({ accountId }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        fetch(`/api/players/${accountId}/mvps`)
            .then(res => {
                if (res.status === 404) throw new Error('No such player');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(d => setData(d))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, [accountId]);

    useEffect(() => { load(); }, [load]);

    const name = data?.player?.name;
    const count = data?.matches?.length || 0;

    return (
        <div className="page-content pc-matches">
            <div className="page-header">
                <h1>{name ? `${name}'s MVP Matches` : 'MVP Matches'}</h1>
                <p>
                    {data ? `${count} match MVP award${count === 1 ? '' : 's'} in Season ${data.season}` : 'Matches where this player was voted MVP'}
                    {' · '}<Link to={`/players/${accountId}`}>back to profile</Link>
                </p>
            </div>

            {loading && <Spinner label="Loading MVP matches..." />}
            {!loading && error && <ErrorBox message={`Failed to load MVP matches: ${error}`} onRetry={load} />}
            {!loading && !error && data && (
                count === 0 ? (
                    <EmptyState title="No MVPs yet">
                        MVP goes to the highest fantasy score on the winning team of each match.
                    </EmptyState>
                ) : (
                    <div className="match-list">
                        {data.matches.map(m => <MatchCard key={m.match_id} match={m} />)}
                    </div>
                )
            )}
        </div>
    );
}
