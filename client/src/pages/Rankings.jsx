import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBox, EmptyState, PlayerLink } from '../components/shared.jsx';
import MmrChart, { seriesStyle } from '../components/MmrChart.jsx';
import { timeAgo } from '../format.js';

// Season rankings: one leaderboard on screen at a time. Tabs split the
// superlatives (Overview / Core / Support / MMR); within a tab a rail picks
// the category. The MMR tab pairs a chart with its ranked table.

const TABS = ['overview', 'core', 'support', 'mmr'];

function formatValue(v, format) {
    switch (format) {
        case 'percent': return (v * 100).toFixed(1) + '%';
        case 'decimal1': return v.toFixed(1);
        case 'decimal2': return v.toFixed(2);
        case 'signed': return (v > 0 ? '+' : '') + Math.round(v).toLocaleString();
        default: return Math.round(v).toLocaleString();
    }
}

function Avatar({ src, className }) {
    if (!src) return <div className={className}></div>;
    return <img src={src} alt="" className={className} />;
}

function Leaderboard({ category, minGames }) {
    const rows = category.rows || [];
    if (!rows.length) {
        return (
            <div className="board">
                <div className="board-head">
                    <h2>{category.title}</h2>
                    <p>{category.subtitle}</p>
                </div>
                <p className="board-empty">Nobody qualifies yet — {minGames} games needed.</p>
            </div>
        );
    }
    const [first, ...rest] = rows;
    return (
        <div className="board">
            <div className="board-head">
                <h2>{category.title}</h2>
                <p>{category.subtitle}</p>
            </div>
            <div className="board-top">
                <div className="board-top-rank">#1</div>
                <Avatar src={first.avatar} className="board-top-avatar" />
                <div className="board-top-body">
                    <div className="board-top-name"><PlayerLink name={first.name} accountId={first.accountId} /></div>
                    <div className="board-top-detail">{first.detail}{first.detail ? ' · ' : ''}{first.games} game{first.games === 1 ? '' : 's'}</div>
                </div>
                <div className="board-top-value">{formatValue(first.value, category.format)}</div>
            </div>
            <table className="board-table">
                <tbody>
                    {rest.map((r, i) => (
                        <tr key={r.accountId}>
                            <td className={'rank-number' + (i < 2 ? ' top-3' : '')}>{i + 2}</td>
                            <td>
                                <div className="player-cell">
                                    <Avatar src={r.avatar} className="player-avatar" />
                                    <span className="player-name"><PlayerLink name={r.name} accountId={r.accountId} /></span>
                                </div>
                            </td>
                            <td className="stat-secondary hide-mobile">{r.detail}</td>
                            <td className="stat-secondary">{r.games} g</td>
                            <td className="stat-value">{formatValue(r.value, category.format)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function MmrPanel({ mmr }) {
    const [hover, setHover] = useState(null);   // transient (table row / line hover)
    const [pinned, setPinned] = useState(null); // click to keep a player lifted
    const highlighted = hover ?? pinned;
    const players = mmr.players || [];

    if (!players.length) {
        return (
            <div className="board">
                <div className="board-head"><h2>Biggest MMR Climb</h2><p>Most Garg MMR gained this season</p></div>
                <p className="board-empty">No MMR history yet — it builds from the bot's match records ({mmr.minGames}+ games needed).</p>
            </div>
        );
    }

    const onHighlight = (id, source) => {
        if (source === 'chart') setHover(id);
    };

    return (
        <div className="board mmr-panel">
            <div className="board-head">
                <h2>Biggest MMR Climb</h2>
                <p>Garg MMR change since each player's first game of the season ({mmr.since ? 'from ' + new Date(mmr.since * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'season start'}) — hover a name to trace their line, click to pin. {mmr.minGames}+ games to qualify.</p>
            </div>
            <div className="mmr-figure">
                <ul className="mmr-legend" aria-label="Players">
                    {players.map((p, i) => {
                        const st = seriesStyle(i);
                        return (
                            <li key={p.accountId}
                                className={(p.accountId === highlighted ? 'active' : '') + (p.accountId === pinned ? ' pinned' : '')}
                                tabIndex={0}
                                onMouseEnter={() => setHover(p.accountId)}
                                onMouseLeave={() => setHover(null)}
                                onFocus={() => setHover(p.accountId)}
                                onBlur={() => setHover(null)}
                                onClick={() => setPinned(pinned === p.accountId ? null : p.accountId)}>
                                <span className="mmr-key" style={{ borderTopColor: st.color, borderTopStyle: st.dash ? 'dashed' : 'solid' }} />
                                <span className="mmr-legend-name">{p.name}</span>
                                <span className="mmr-legend-gain">{formatValue(p.gain, 'signed')}</span>
                            </li>
                        );
                    })}
                </ul>
                <MmrChart players={players} highlighted={highlighted} onHighlight={onHighlight} />
            </div>
            <table className="board-table mmr-table">
                <thead>
                    <tr><th>#</th><th>Player</th><th className="hide-mobile">Games</th><th className="hide-mobile">Start</th><th>Now</th><th>Gain</th></tr>
                </thead>
                <tbody>
                    {players.map((p, i) => (
                        <tr key={p.accountId}
                            className={(p.accountId === highlighted ? 'active' : '') + (p.accountId === pinned ? ' pinned' : '')}
                            tabIndex={0}
                            onMouseEnter={() => setHover(p.accountId)}
                            onMouseLeave={() => setHover(null)}
                            onFocus={() => setHover(p.accountId)}
                            onBlur={() => setHover(null)}
                            onClick={() => setPinned(pinned === p.accountId ? null : p.accountId)}>
                            <td className={'rank-number' + (i < 3 ? ' top-3' : '')}>{i + 1}</td>
                            <td>
                                <div className="player-cell">
                                    <Avatar src={p.avatar} className="player-avatar" />
                                    <span className="player-name"><PlayerLink name={p.name} accountId={p.accountId} /></span>
                                </div>
                            </td>
                            <td className="stat-secondary hide-mobile">{p.games}</td>
                            <td className="stat-secondary hide-mobile">{p.startMmr.toLocaleString()}</td>
                            <td className="stat-secondary">{p.currentMmr.toLocaleString()}</td>
                            <td className={'stat-value' + (p.gain < 0 ? ' negative' : '')}>{formatValue(p.gain, 'signed')}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function Rankings() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState(() => {
        const t = new URLSearchParams(window.location.search).get('tab');
        return TABS.includes(t) ? t : 'overview';
    });
    const [category, setCategory] = useState({}); // per tab: selected category key

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        fetch('/api/rankings')
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(d => setData(d))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    const selectTab = (t) => {
        setTab(t);
        const url = new URL(window.location.href);
        if (t === 'overview') url.searchParams.delete('tab'); else url.searchParams.set('tab', t);
        window.history.replaceState({}, '', url.pathname + url.search);
    };

    let body = null;
    if (loading) body = <Spinner label="Loading rankings..." />;
    else if (error) body = <ErrorBox message={`Failed to load rankings: ${error}`} onRetry={load} />;
    else if (data) {
        const tabDef = data.tabs[tab];
        if (tab === 'mmr') {
            body = <MmrPanel mmr={data.mmr} />;
        } else if (tabDef) {
            const cats = tabDef.categories.filter(c => !c.chart || c.rows.length > 0);
            const hasAny = cats.some(c => c.rows.length > 0);
            const selectedKey = category[tab] || (cats[0] && cats[0].key);
            const selected = cats.find(c => c.key === selectedKey) || cats[0];
            const minGames = tab === 'overview' ? data.minMatches : data.minRoleMatches;
            body = !hasAny ? (
                <EmptyState title={tab === 'overview' ? 'No rankings yet' : 'Role data is still being crawled'}>
                    {tab === 'overview'
                        ? 'Rankings will appear once enough matches are played.'
                        : 'Core and support boards fill in after the next season crawl finishes.'}
                </EmptyState>
            ) : (
                <div className="rank-layout">
                    {tab !== 'overview' && data.roleSource && (() => {
                        const lane = data.roleSource.lane || 0;
                        const total = Object.values(data.roleSource).reduce((a, b) => a + b, 0);
                        if (!total) return null;
                        const pct = Math.round((lane / total) * 100);
                        return (
                            <div className={'role-source-note' + (pct < 80 ? ' warn' : '')}>
                                Core/support roles come from OpenDota lane data for {pct}% of games ({lane} of {total});
                                the rest use a wards/GPM estimate{pct < 80 ? ' — treat these boards as approximate until more matches are parsed' : ''}.
                            </div>
                        );
                    })()}
                    <nav className="rank-rail" aria-label="Superlatives">
                        {cats.map(c => (
                            <button key={c.key} type="button"
                                className={'rail-item' + (c.key === selected.key ? ' active' : '')}
                                onClick={() => {
                                    if (c.chart) { selectTab('mmr'); return; }
                                    setCategory(prev => ({ ...prev, [tab]: c.key }));
                                }}>
                                <span className="rail-title">{c.title}</span>
                                <span className="rail-sub">{c.chart ? 'Chart →' : (c.rows[0] ? c.rows[0].name : '—')}</span>
                            </button>
                        ))}
                    </nav>
                    <div className="rank-main">
                        {selected && <Leaderboard category={selected} minGames={minGames} />}
                    </div>
                </div>
            );
        }
    }

    return (
        <div className="page-content pc-rankings">
            <div className="page-header">
                <h1>Season {data?.season || 2} Rankings</h1>
                <p>Best players in the Gargamel League</p>
                {data?.lastUpdated ? (
                    <div className="cache-info">
                        Data refreshed {timeAgo(data.lastUpdated)}
                        {' · '}based on {data.matchesAnalyzed || 0} Season {data.season} matches
                        {data.minMatches ? ` · min ${data.minMatches} games to qualify (${data.minRoleMatches} per role)` : ''}
                    </div>
                ) : null}
            </div>

            <div className="rank-tabs" role="tablist">
                {TABS.map(t => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t}
                        className={'rank-tab' + (tab === t ? ' active' : '')}
                        onClick={() => selectTab(t)}>
                        {t === 'mmr' ? 'MMR' : t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                ))}
            </div>

            {body}
        </div>
    );
}
