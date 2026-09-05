import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../format.js';
import { PlayerLink } from '../components/shared.jsx';
import Minimap from '../components/Minimap.jsx';
import MinimapCalibrator from '../components/MinimapCalibrator.jsx';
import { getMinimapConfig } from '../minimap.js';

const POLL_INTERVAL = 5000; // Poll every 5 seconds

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
                                <span className="player-name-cell">
                                    <PlayerLink name={p.name} accountId={p.accountId} />
                                </span>
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

function GameContent({ game, minimapConfig }) {
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
                <Minimap
                    structures={minimapConfig.structures}
                    bounds={minimapConfig.bounds}
                    inset={minimapConfig.inset}
                    radiant={game.radiant}
                    dire={game.dire}
                />
                {minimapConfig.overridden && (
                    <div className="minimap-override-note">Using this browser's minimap calibration override.</div>
                )}
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
    const [calibrate] = useState(() => new URLSearchParams(window.location.search).get('calibrate') === '1');
    const [minimapConfig] = useState(getMinimapConfig);

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

    if (calibrate) {
        return (
            <div className="page-content pc-live">
                <MinimapCalibrator liveGames={games} />
            </div>
        );
    }

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
                <GameContent game={selected} minimapConfig={minimapConfig} />
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
