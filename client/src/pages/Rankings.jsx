import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBox, EmptyState, PlayerLink } from '../components/shared.jsx';
import { formatPercent, timeAgo } from '../format.js';

function Avatar({ src, className }) {
    if (!src) return <div className={className}></div>;
    return <img src={src} alt="" className={className} />;
}

function PlayerCell({ player }) {
    return (
        <div className="player-cell">
            <Avatar src={player.avatar} className="player-avatar" />
            <span className="player-name">
                <PlayerLink name={player.name} accountId={player.accountId} />
            </span>
        </div>
    );
}

const Games = ({ n }) => <span className="stat-muted">({n} games)</span>;

// One ranking table card. `columns` describes everything after the player cell:
// [{ header, className, render(player) }]
function RankingCard({ title, subtitle, players, columns, cardClass, headerClass }) {
    if (!players || players.length === 0) return null;
    return (
        <div className={`ranking-card${cardClass ? ' ' + cardClass : ''}`}>
            <div className={`ranking-header${headerClass ? ' ' + headerClass : ''}`}>
                <h2>{title}</h2>
                <p>{subtitle}</p>
            </div>
            <table className="ranking-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Player</th>
                        {columns.map(c => <th key={c.header} className={c.headerClassName}>{c.header}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {players.map((player, i) => (
                        <tr key={player.accountId}>
                            <td className={i < 3 ? 'rank-number top-3' : 'rank-number'}>{i + 1}</td>
                            <td><PlayerCell player={player} /></td>
                            {columns.map(c => (
                                <td key={c.header} className={c.className}>{c.render(player)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PotmCard({ p }) {
    return (
        <div className="potm-card">
            <Avatar src={p.avatar} className="potm-avatar" />
            <div className="potm-info">
                <h2>League MVP</h2>
                <div className="potm-name"><PlayerLink name={p.name} accountId={p.accountId} /></div>
                <div className="potm-stats">
                    <strong>{p.mvpCount}</strong> MVP{p.mvpCount !== 1 ? 's' : ''}
                    {' · '}<strong>{p.svpCount}</strong> SVP{p.svpCount !== 1 ? 's' : ''}
                    {' · '}{p.wins}W-{p.losses}L
                </div>
            </div>
            <div className="potm-star">★</div>
        </div>
    );
}

function obsDuration(player) {
    if (player.avgObsWardDuration == null) return '';
    const mins = Math.floor(player.avgObsWardDuration / 60);
    const secs = ('0' + Math.floor(player.avgObsWardDuration % 60)).slice(-2);
    return `${mins}:${secs}`;
}

export default function Rankings() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        fetch('/api/top-rankings')
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(d => setData(d))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    const isEmpty = data
        && (!data.topByWinRate || data.topByWinRate.length === 0)
        && (!data.topByKDA || data.topByKDA.length === 0)
        && (!data.topByGPM || data.topByGPM.length === 0)
        && (!data.topByWards || data.topByWards.length === 0)
        && (!data.topByMidas || data.topByMidas.length === 0);

    return (
        <div className="page-content pc-rankings">
            <div className="page-header">
                <h1>Season 2 Rankings</h1>
                <p>Best players in the Gargamel League</p>
                {data?.lastUpdated ? (
                    <div className="cache-info">
                        Data refreshed {timeAgo(data.lastUpdated)}
                        {' · '}based on {data.matchesAnalyzed || 0} Season 2 matches
                        {' · '}updates every {Math.round(data.cacheMaxAge / (60 * 60 * 1000))} hours
                        {data.minMatchesRequired ? ` · min ${data.minMatchesRequired} games to qualify` : ''}
                    </div>
                ) : null}
            </div>

            {loading && <Spinner label="Loading rankings..." />}
            {!loading && error && <ErrorBox message={`Failed to load rankings: ${error}`} onRetry={load} />}
            {!loading && !error && data && (isEmpty ? (
                <EmptyState title="No rankings yet">
                    Rankings will appear once enough matches are played.
                </EmptyState>
            ) : (
                <>
                    {data.playerOfTheMonth && <PotmCard p={data.playerOfTheMonth} />}

                    <div className="rankings-grid">
                        <RankingCard
                            title="Top 10 by Win Rate"
                            subtitle="Best win/loss ratios"
                            players={data.topByWinRate}
                            columns={[
                                {
                                    header: 'W/L', className: 'stat-secondary',
                                    render: p => <>{p.wins}-{p.losses} <Games n={p.matches} /></>,
                                },
                                {
                                    header: 'Win Rate',
                                    render: p => (
                                        <>
                                            <div className="stat-value">{formatPercent(p.winRate)}</div>
                                            <div className="win-rate-bar">
                                                <div className="win-rate-fill" style={{ width: (p.winRate * 100) + '%' }}></div>
                                            </div>
                                        </>
                                    ),
                                },
                            ]}
                        />

                        <RankingCard
                            title="Top 10 by K/D/A"
                            subtitle="Best K/D/A ratios"
                            players={data.topByKDA}
                            columns={[
                                {
                                    header: 'Avg K/D/A', className: 'stat-secondary',
                                    render: p => <>{Math.round(p.avgKills)} / {Math.round(p.avgDeaths)} / {Math.round(p.avgAssists)} <Games n={p.matches} /></>,
                                },
                                { header: 'Ratio', className: 'stat-value', render: p => p.kda.toFixed(2) },
                            ]}
                        />

                        <RankingCard
                            title="Top 10 by GPM"
                            subtitle="Best gold per minute averages"
                            players={data.topByGPM}
                            columns={[
                                {
                                    header: 'Avg Net Worth', className: 'stat-secondary',
                                    render: p => <>{Math.round(p.avgNetWorth).toLocaleString()} <Games n={p.matches} /></>,
                                },
                                { header: 'Avg GPM', className: 'stat-value', render: p => Math.round(p.avgGPM) },
                            ]}
                        />

                        <RankingCard
                            title="Top 10 Unsung Heroes"
                            subtitle="Four Wards in Stock, Guys"
                            players={data.topByWards}
                            columns={[
                                {
                                    header: 'Total Wards Placed', className: 'stat-secondary',
                                    render: p => <>{p.wards_placed.toLocaleString()} <Games n={p.matches} /></>,
                                },
                                {
                                    header: 'Avg Obs Duration', headerClassName: 'hide-mobile',
                                    className: 'stat-secondary hide-mobile', render: obsDuration,
                                },
                                { header: 'Avg/Game', className: 'stat-value', render: p => p.avgWards.toFixed(1) },
                            ]}
                        />

                        <RankingCard
                            title="Top 10 Players with True Sight"
                            subtitle="Best Dewarders"
                            players={data.topByDewards}
                            columns={[
                                {
                                    header: 'Total Dewards', className: 'stat-secondary',
                                    render: p => <>{p.observer_kills.toLocaleString()} <Games n={p.matches} /></>,
                                },
                                { header: 'Avg/Game', className: 'stat-value', render: p => p.avgDewards.toFixed(2) },
                            ]}
                        />

                        <RankingCard
                            title="Midas Score"
                            subtitle="Most Net Worth with Least Fight Participation"
                            players={data.topByMidas}
                            cardClass="midas-card"
                            headerClass="midas-header"
                            columns={[
                                {
                                    header: 'Avg Net Worth', headerClassName: 'midas-hide-mobile',
                                    className: 'stat-secondary midas-hide-mobile',
                                    render: p => <>{Math.round(p.avgNetWorth).toLocaleString()} gold <Games n={p.matches} /></>,
                                },
                                {
                                    header: 'Avg K+A', className: 'stat-secondary',
                                    render: p => (p.avgKills + p.avgAssists).toFixed(1) + '/game',
                                },
                                {
                                    header: 'Midas Score', className: 'stat-value stat-gold',
                                    render: p => Math.round(p.midasScore).toLocaleString(),
                                },
                            ]}
                        />
                    </div>
                </>
            ))}
        </div>
    );
}
