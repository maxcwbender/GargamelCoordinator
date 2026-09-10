import { useCallback, useEffect, useState } from 'react';
import { Link } from '../router.jsx';
import { Spinner, ErrorBox, EmptyState } from '../components/shared.jsx';
import { MatchCard } from './Matches.jsx';

// /players/:id/mvps and /players/:id/svps: every Season match where the
// player won the award, shown with the same match cards as the Matches page
// (the gold ★ marks the MVP, the silver one the SVP).
const AWARDS = {
    mvp: {
        label: 'MVP',
        blurb: 'Matches where this player was the MVP',
        explain: 'MVP goes to the highest fantasy score on the winning team of each match.',
    },
    svp: {
        label: 'SVP',
        blurb: 'Matches where this player was the SVP',
        explain: 'SVP goes to the highest fantasy score on the losing team of each match: the best player in a loss.',
    },
};

export default function PlayerAwards({ accountId, award = 'mvp' }) {
    const info = AWARDS[award] || AWARDS.mvp;
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        fetch(`/api/players/${accountId}/${award}s`)
            .then(res => {
                if (res.status === 404) throw new Error('No such player');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(d => setData(d))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, [accountId, award]);

    useEffect(() => { load(); }, [load]);

    const name = data?.player?.name;
    const count = data?.matches?.length || 0;

    return (
        <div className="page-content pc-matches">
            <div className="page-header">
                <h1>{name ? `${name}'s ${info.label} Matches` : `${info.label} Matches`}</h1>
                <p>
                    {data ? `${count} match ${info.label} award${count === 1 ? '' : 's'} in Season ${data.season}` : info.blurb}
                    {' · '}<Link to={`/players/${accountId}`}>back to profile</Link>
                </p>
            </div>

            {loading && <Spinner label={`Loading ${info.label} matches...`} />}
            {!loading && error && <ErrorBox message={`Failed to load ${info.label} matches: ${error}`} onRetry={load} />}
            {!loading && !error && data && (
                count === 0 ? (
                    <EmptyState title={`No ${info.label}s yet`}>
                        {info.explain}
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
