import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBox, EmptyState, PlayerLink } from '../components/shared.jsx';
import { formatDuration, formatMatchDate, timeAgo, GAME_MODES } from '../format.js';

function HeroIcon({ heroImg, heroName, className, placeholderClass }) {
    const [failed, setFailed] = useState(false);
    if (!heroImg || failed) return <div className={placeholderClass}></div>;
    return (
        <img
            src={heroImg}
            alt={heroName || ''}
            title={heroName || ''}
            className={className}
            onError={() => setFailed(true)}
        />
    );
}

function PlayerRow({ p }) {
    const liClass = p.isMVP ? 'player-mvp' : (p.isSVP ? 'player-svp' : undefined);
    return (
        <li className={liClass}>
            <HeroIcon heroImg={p.heroImg} heroName={p.heroName} className="player-hero" placeholderClass="player-hero-placeholder" />
            <span className="player-name-text">
                <PlayerLink name={p.personaname} accountId={p.account_id} />
            </span>
            {p.isMVP && <span className="vp-star gold" title="Match MVP">★</span>}
            {p.isSVP && <span className="vp-star silver" title="Match SVP">★</span>}
        </li>
    );
}

function TeamPanel({ side, players }) {
    const radiant = side === 'radiant';
    return (
        <div className={`team-panel ${radiant ? 'team-radiant' : 'team-dire'}`}>
            <div className={`team-label ${radiant ? 'label-radiant' : 'label-dire'}`}>
                <span className={`team-indicator ${radiant ? 'indicator-radiant' : 'indicator-dire'}`}></span>
                {radiant ? 'Radiant' : 'Dire'}
            </div>
            <ul className="player-list">
                {players.map(p => <PlayerRow key={p.player_slot} p={p} />)}
            </ul>
        </div>
    );
}

function MatchCard({ match }) {
    const radiantPlayers = match.players.filter(p => p.isRadiant);
    const direPlayers = match.players.filter(p => !p.isRadiant);
    return (
        <div className="match-card">
            <div className="match-header">
                <div className="match-info">
                    <span className="match-id">
                        <a href={`https://www.opendota.com/matches/${match.match_id}`} target="_blank" rel="noopener noreferrer">
                            View on OpenDota
                        </a>
                    </span>
                    {match.start_time != null && <span className="match-date">{formatMatchDate(match.start_time)}</span>}
                    {match.game_mode != null && <span className="match-mode">{GAME_MODES[match.game_mode] || 'Mode ' + match.game_mode}</span>}
                </div>
                <span className={`match-winner ${match.radiant_win ? 'winner-radiant' : 'winner-dire'}`}>
                    {match.radiant_win ? 'Radiant Victory' : 'Dire Victory'}
                </span>
                {match.duration != null && <span className="match-duration">{formatDuration(match.duration)}</span>}
            </div>

            <div className="match-body">
                <TeamPanel side="radiant" players={radiantPlayers} />
                <div className="score-divider">
                    <div className="score-label">Kills</div>
                    <div className="score-value score-radiant">{match.radiant_score != null ? match.radiant_score : '-'}</div>
                    <div className="score-separator"></div>
                    <div className="score-value score-dire">{match.dire_score != null ? match.dire_score : '-'}</div>
                </div>
                <TeamPanel side="dire" players={direPlayers} />
            </div>
        </div>
    );
}

export default function Matches() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        fetch('/api/recent-matches')
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(d => setData(d))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="page-content pc-matches">
            <div className="page-header">
                <h1>Recent Matches</h1>
                <p>Last 10 matches from Gargamel League</p>
                {data?.lastUpdated ? (
                    <div className="cache-info">
                        Data refreshed {timeAgo(data.lastUpdated)} · auto-refreshes every {Math.round(data.cacheMaxAge / 60000)} min
                    </div>
                ) : null}
            </div>

            {loading && <Spinner label="Loading matches..." />}
            {!loading && error && <ErrorBox message={`Failed to load matches: ${error}`} onRetry={load} />}
            {!loading && !error && data && (
                (!data.matches || data.matches.length === 0) ? (
                    <EmptyState title="No matches yet">
                        Matches will appear here once games are played in the Gargamel League.
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
