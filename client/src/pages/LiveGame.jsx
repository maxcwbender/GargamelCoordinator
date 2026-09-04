import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../format.js';

const POLL_INTERVAL = 5000; // Poll every 5 seconds

// Tower positions on minimap (as percentages)
// Radiant base is bottom-left, Dire base is top-right
// Bit order: 0=TopT1, 1=TopT2, 2=TopT3, 3=MidT1, 4=MidT2, 5=MidT3, 6=BotT1, 7=BotT2, 8=BotT3, 9=AncientTop, 10=AncientBot
const TOWER_POSITIONS = {
    radiant: [
        { bit: 0, x: 13, y: 25 },
        { bit: 1, x: 13, y: 48 },
        { bit: 2, x: 13, y: 73 },
        { bit: 3, x: 44, y: 56 },
        { bit: 4, x: 32, y: 68 },
        { bit: 5, x: 24, y: 76 },
        { bit: 6, x: 72, y: 85 },
        { bit: 7, x: 48, y: 85 },
        { bit: 8, x: 26, y: 87 },
        { bit: 9, x: 17, y: 80 },
        { bit: 10, x: 21, y: 84 },
    ],
    dire: [
        { bit: 0, x: 28, y: 14 },
        { bit: 1, x: 52, y: 14 },
        { bit: 2, x: 74, y: 13 },
        { bit: 3, x: 56, y: 44 },
        { bit: 4, x: 68, y: 32 },
        { bit: 5, x: 76, y: 24 },
        { bit: 6, x: 87, y: 72 },
        { bit: 7, x: 87, y: 48 },
        { bit: 8, x: 87, y: 27 },
        { bit: 9, x: 80, y: 16 },
        { bit: 10, x: 84, y: 20 },
    ]
};

// Barracks positions on minimap
// Bit order: 0=TopMelee, 1=TopRanged, 2=MidMelee, 3=MidRanged, 4=BotMelee, 5=BotRanged
const BARRACKS_POSITIONS = {
    radiant: [
        { bit: 0, x: 11, y: 74, label: 'Top Melee' },
        { bit: 1, x: 15, y: 74, label: 'Top Ranged' },
        { bit: 2, x: 22, y: 78, label: 'Mid Melee' },
        { bit: 3, x: 26, y: 78, label: 'Mid Ranged' },
        { bit: 4, x: 24, y: 89, label: 'Bot Melee' },
        { bit: 5, x: 28, y: 89, label: 'Bot Ranged' },
    ],
    dire: [
        { bit: 0, x: 72, y: 11, label: 'Top Melee' },
        { bit: 1, x: 76, y: 11, label: 'Top Ranged' },
        { bit: 2, x: 74, y: 22, label: 'Mid Melee' },
        { bit: 3, x: 78, y: 22, label: 'Mid Ranged' },
        { bit: 4, x: 85, y: 25, label: 'Bot Melee' },
        { bit: 5, x: 89, y: 25, label: 'Bot Ranged' },
    ]
};

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function Towers({ towerState, team }) {
    return TOWER_POSITIONS[team].map(t => {
        const isAlive = (towerState & (1 << t.bit)) !== 0;
        return (
            <div
                key={t.bit}
                className={`tower ${team}${isAlive ? '' : ' destroyed'}`}
                style={{ left: t.x + '%', top: t.y + '%' }}
                title={`${cap(team)} Tower (Bit ${t.bit})`}
            ></div>
        );
    });
}

function Barracks({ barracksState, team }) {
    return BARRACKS_POSITIONS[team].map(r => {
        const isAlive = (barracksState & (1 << r.bit)) !== 0;
        return (
            <div
                key={r.bit}
                className={`barracks ${team}${isAlive ? '' : ' destroyed'}`}
                style={{ left: r.x + '%', top: r.y + '%' }}
                title={`${cap(team)} ${r.label}`}
            ></div>
        );
    });
}

function PlayerDots({ players, team }) {
    return players
        .filter(p => p.posX != null && p.posY != null)
        .map((p, i) => {
            const x = (p.posX / 255) * 100;
            const y = 100 - (p.posY / 255) * 100;
            const heroLabel = p.heroName ? p.heroName + ' - ' : '';
            return (
                <div
                    key={p.accountId || i}
                    className={`player-dot ${team}${p.respawnTimer > 0 ? ' dead' : ''}`}
                    style={{ left: x + '%', top: y + '%' }}
                    title={`${heroLabel}${p.name} (Lvl ${p.level})`}
                ></div>
            );
        });
}

function ItemSlot({ item }) {
    const [failed, setFailed] = useState(false);
    if (!item || !item.img || failed) return <div className="item-empty"></div>;
    return (
        <img
            src={item.img}
            alt={item.name}
            title={item.name}
            className="item-slot"
            onError={() => setFailed(true)}
        />
    );
}

function HeroIcon({ heroImg, heroName }) {
    const [failed, setFailed] = useState(false);
    if (!heroImg || failed) return <div className="hero-placeholder"></div>;
    return (
        <img src={heroImg} alt={heroName || ''} title={heroName || ''} className="hero-icon" onError={() => setFailed(true)} />
    );
}

function PlayersTable({ players }) {
    return (
        <table className="players-table">
            <thead>
                <tr>
                    <th>Player</th>
                    <th>Lvl</th>
                    <th>K/D/A</th>
                    <th className="lg-hide-mobile">LH/DN</th>
                    <th className="lg-hide-mobile">GPM</th>
                    <th>Net Worth</th>
                    <th>Items</th>
                </tr>
            </thead>
            <tbody>
                {players.map((p, i) => (
                    <tr key={p.accountId || i}>
                        <td>
                            <div className="hero-cell">
                                <HeroIcon heroImg={p.heroImg} heroName={p.heroName} />
                                {p.accountId ? (
                                    <a
                                        href={`https://www.opendota.com/players/${p.accountId}`}
                                        target="_blank" rel="noopener noreferrer"
                                        className="player-name-cell"
                                    >{p.name}</a>
                                ) : (
                                    <span className="player-name-cell">{p.name}</span>
                                )}
                            </div>
                        </td>
                        <td>{p.level}</td>
                        <td className="kda-cell">{p.kills}/{p.deaths}/{p.assists}</td>
                        <td className="cs-cell lg-hide-mobile">{p.lastHits || 0}/{p.denies || 0}</td>
                        <td className="gpm-cell lg-hide-mobile">{p.gpm || 0}</td>
                        <td className="net-worth-cell">{p.netWorth.toLocaleString()}</td>
                        <td>
                            <div className="item-grid">
                                {[0, 1, 2, 3, 4, 5].map(slot => <ItemSlot key={slot} item={p.items && p.items[slot]} />)}
                            </div>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function GameContent({ game }) {
    const hasPositions = [...game.radiant.players, ...game.dire.players]
        .some(p => p.posX != null && p.posY != null);

    return (
        <>
            <div className="lg-match-header">
                <div className="lg-match-time">{formatDuration(game.duration)}</div>
                <div className="lg-match-score">{game.radiant.score} - {game.dire.score}</div>
                <div>
                    <div className="spectator-count">{game.spectators} watching</div>
                    <div className="delay-notice">Live feed is on a ~2 minute delay</div>
                </div>
            </div>

            <div className="minimap-container">
                <h3>Live Minimap</h3>
                <div className="minimap">
                    <div className="minimap-grid"></div>
                    <PlayerDots players={game.radiant.players} team="radiant" />
                    <PlayerDots players={game.dire.players} team="dire" />
                    {!hasPositions && <div className="minimap-no-positions">Position data not available</div>}
                    <Towers towerState={game.radiant.towerState || 0} team="radiant" />
                    <Towers towerState={game.dire.towerState || 0} team="dire" />
                    <Barracks barracksState={game.radiant.barracksState || 0} team="radiant" />
                    <Barracks barracksState={game.dire.barracksState || 0} team="dire" />
                </div>
            </div>

            <div className="teams-container">
                <div className="team-card radiant">
                    <div className="team-header">
                        <div className="team-name">Radiant</div>
                        <div className="team-score radiant-score">{game.radiant.score}</div>
                    </div>
                    <PlayersTable players={game.radiant.players} />
                </div>
                <div className="team-card dire">
                    <div className="team-header">
                        <div className="team-name">Dire</div>
                        <div className="team-score dire-score">{game.dire.score}</div>
                    </div>
                    <PlayersTable players={game.dire.players} />
                </div>
            </div>
        </>
    );
}

const LiveBadge = () => (
    <div className="live-badge">
        <div className="live-dot"></div>
        <span>LIVE</span>
    </div>
);

export default function LiveGame() {
    const [games, setGames] = useState([]);
    const [pendingGames, setPendingGames] = useState([]);
    // Track the selected match by id so the user's tab choice survives poll refreshes
    const [selectedMatchId, setSelectedMatchId] = useState(null);
    const selectedRef = useRef(null);
    selectedRef.current = selectedMatchId;

    useEffect(() => {
        let cancelled = false;

        async function fetchGames() {
            try {
                const response = await fetch('/api/live-game');
                const data = await response.json();
                if (cancelled) return;

                const newGames = (data.active && data.games) ? data.games : [];
                setGames(newGames);
                setPendingGames(data.pendingGames || []);

                const current = selectedRef.current;
                if (newGames.length === 0) {
                    setSelectedMatchId(null);
                } else if (!newGames.some(g => g.matchId === current)) {
                    setSelectedMatchId(newGames[0].matchId);
                }
            } catch {
                if (!cancelled) {
                    setGames([]);
                    setPendingGames([]);
                }
            }
        }

        fetchGames();
        const timer = setInterval(fetchGames, POLL_INTERVAL);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    let body;
    if (games.length > 0) {
        const selected = games.find(g => g.matchId === selectedMatchId) || games[0];
        body = (
            <>
                <LiveBadge />
                {games.length > 1 && (
                    <div className="game-tabs">
                        {games.map((game, index) => (
                            <button
                                key={game.matchId}
                                className={'game-tab' + (game.matchId === selected.matchId ? ' active' : '')}
                                onClick={() => setSelectedMatchId(game.matchId)}
                            >
                                <span>Game {index + 1}</span>
                                <span className="tab-score">{game.radiant.score} - {game.dire.score}</span>
                                <span className="tab-duration">{formatDuration(game.duration)}</span>
                            </button>
                        ))}
                    </div>
                )}
                <GameContent game={selected} />
                {pendingGames.length > 0 && (
                    <div className="pending-notice">
                        {pendingGames.length} additional game{pendingGames.length > 1 ? 's' : ''} in picking phase
                    </div>
                )}
            </>
        );
    } else if (pendingGames.length > 0) {
        const pending = pendingGames[0];
        body = (
            <div className="no-game">
                <LiveBadge />
                <h2>Game Starting...</h2>
                <p>A live game has been detected and is currently in the picking phase.</p>
                <p style={{ marginTop: 12 }}>Live stats will appear once the game begins.</p>
                {pending.matchId ? <p className="match-id-note">Match ID: {pending.matchId}</p> : null}
            </div>
        );
    } else {
        body = (
            <div className="no-game">
                <h2>No Live Games</h2>
                <p>There are no active games in the league right now.</p>
                <p style={{ marginTop: 12 }}>This page will update automatically when a game starts.</p>
            </div>
        );
    }

    return <div className="page-content pc-live">{body}</div>;
}
