import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, loginUrl } from '../auth.jsx';
import { Spinner, ErrorBox, PlayerLink } from '../components/shared.jsx';
import RegistrationFields from '../components/RegistrationFields.jsx';
import { formatDuration, formatMatchDate, GAME_MODES } from '../format.js';
import ProfileDemoControls from '../components/ProfileDemoControls.jsx';
import { buildDemoProfile, DEMO_DEFAULT_OPTIONS, DEMO_HEROES, DEMO_VETO_MODES, DEMO_ACCOUNT_ID, heroById } from '../demoProfile.js';

// Player profile. accountId === null means "the logged-in user's own profile"
// (/profile); otherwise it's the public page for that OpenDota account id
// (/players/:id), which works for anyone who has played a league match.

function HeroImg({ hero, className }) {
    const [failed, setFailed] = useState(false);
    if (!hero?.img || failed) return <div className={className + ' hero-img-placeholder'} title={hero?.name || ''} />;
    return <img className={className} src={hero.img} alt={hero.name} title={hero.name} onError={() => setFailed(true)} />;
}

function pct(wins, games) {
    return games > 0 ? Math.round((wins / games) * 100) + '%' : '–';
}

// Read one-shot flags from the URL (?linked=1, ?linkError=..., ?authError=...)
// and strip them so a refresh doesn't repeat the banner.
function takeUrlFlags() {
    const params = new URLSearchParams(window.location.search);
    const flags = {
        linked: params.get('linked') === '1',
        linkError: params.get('linkError'),
        authError: params.get('authError'),
    };
    if (flags.linked || flags.linkError || flags.authError) {
        window.history.replaceState({}, '', window.location.pathname);
    }
    return flags;
}

// ── Preferences (favorite heroes, position, veto) ─────────────────────────
// saveHandler (demo mode) replaces the PUT with a local function returning the
// updated profile; fallback lists cover the case where the API isn't reachable.
function PreferencesCard({ profile, onSaved, saveHandler = null, fallbackHeroes = null, fallbackVetoModes = null }) {
    const [heroes, setHeroes] = useState([]);
    const [options, setOptions] = useState({ positions: [], vetoModes: [] });
    const [favHeroes, setFavHeroes] = useState(profile.prefs.favHeroes.map(h => h.id));
    const [favPosition, setFavPosition] = useState(profile.prefs.favPosition || '');
    const [vetoMode, setVetoMode] = useState(profile.prefs.vetoMode ? String(profile.prefs.vetoMode.id) : '');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null); // { text, error }

    useEffect(() => {
        if (!profile.isOwner) return;
        fetch('/api/heroes').then(r => r.json())
            .then(list => setHeroes(Array.isArray(list) && list.length ? list : (fallbackHeroes || [])))
            .catch(() => { if (fallbackHeroes) setHeroes(fallbackHeroes); });
        fetch('/api/profile-options').then(r => r.json()).then(o => setOptions({
            positions: o.positions || [],
            vetoModes: (o.vetoModes && o.vetoModes.length) ? o.vetoModes : (fallbackVetoModes || []),
        })).catch(() => { if (fallbackVetoModes) setOptions(op => ({ ...op, vetoModes: fallbackVetoModes })); });
    }, [profile.isOwner]);

    const setHeroAt = (idx, value) => {
        const next = [...favHeroes];
        const id = value ? Number(value) : null;
        if (id == null) next.splice(idx, 1);
        else next[idx] = id;
        setFavHeroes(next.filter(v => v != null).slice(0, 3));
    };

    const save = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
            const payload = { favHeroes, favPosition: favPosition || null, vetoMode: vetoMode ? Number(vetoMode) : null };
            let body;
            if (saveHandler) {
                body = await saveHandler(payload, { heroes, vetoModes: options.vetoModes });
            } else {
                const res = await fetch('/api/profile/prefs', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
            }
            onSaved(body);
            setMessage({ text: 'Preferences saved.', error: false });
        } catch (err) {
            setMessage({ text: err.message, error: true });
        } finally {
            setSaving(false);
        }
    };

    const positionLabel = (key) => options.positions.find(p => p.key === key)?.label
        || { carry: 'Carry', mid: 'Mid', offlane: 'Offlane', soft_support: 'Soft Support', hard_support: 'Hard Support' }[key]
        || key;

    if (!profile.isOwner) {
        const { favHeroes: fav, favPosition: pos, vetoMode: veto } = profile.prefs;
        return (
            <div className="profile-card">
                <h2>Player Preferences</h2>
                <div className="pref-row">
                    <span className="pref-label">Favorite heroes</span>
                    {fav.length ? (
                        <div className="fav-hero-list">
                            {fav.map(h => (
                                <span key={h.id} className="fav-hero">
                                    <HeroImg hero={h} className="fav-hero-img" />
                                    {h.name}
                                </span>
                            ))}
                        </div>
                    ) : <span className="pref-empty">Not set</span>}
                </div>
                <div className="pref-row">
                    <span className="pref-label">Favorite position</span>
                    {pos ? <span className="pref-chip">{positionLabel(pos)}</span> : <span className="pref-empty">Not set</span>}
                </div>
                <div className="pref-row">
                    <span className="pref-label">Vetoed game mode</span>
                    {veto ? <span className="pref-chip veto">🚫 {veto.label}</span> : <span className="pref-empty">None</span>}
                </div>
            </div>
        );
    }

    const heroOptions = (slotIdx) => heroes.filter(h => !favHeroes.includes(h.id) || favHeroes[slotIdx] === h.id);

    return (
        <div className="profile-card">
            <h2>Player Preferences</h2>
            <form className="pref-form" onSubmit={save}>
                <div className="pref-field">
                    <label>Favorite heroes (up to 3)</label>
                    <div className="hero-pickers">
                        {[0, 1, 2].map(idx => (
                            <div key={idx} className="hero-picker">
                                <HeroImg hero={heroes.find(h => h.id === favHeroes[idx]) || profile.prefs.favHeroes[idx]} className="fav-hero-img" />
                                <select value={favHeroes[idx] ?? ''} onChange={e => setHeroAt(idx, e.target.value)} disabled={heroes.length === 0}>
                                    <option value="">{heroes.length ? '— none —' : 'Loading heroes…'}</option>
                                    {heroOptions(idx).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                                </select>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="pref-field">
                    <label>Favorite position</label>
                    <div className="position-options">
                        {(options.positions.length ? options.positions : [
                            { key: 'carry', label: 'Carry' }, { key: 'mid', label: 'Mid' }, { key: 'offlane', label: 'Offlane' },
                            { key: 'soft_support', label: 'Soft Support' }, { key: 'hard_support', label: 'Hard Support' },
                        ]).map(p => (
                            <label key={p.key} className={'position-option' + (favPosition === p.key ? ' selected' : '')}>
                                <input type="radio" name="position" value={p.key} checked={favPosition === p.key}
                                    onChange={() => setFavPosition(p.key)} />
                                {p.label}
                            </label>
                        ))}
                        {favPosition && (
                            <button type="button" className="link-btn" onClick={() => setFavPosition('')}>clear</button>
                        )}
                    </div>
                </div>
                <div className="pref-field">
                    <label>Game mode veto</label>
                    <p className="pref-help">
                        The one mode you absolutely do not want to play. Games you're in will exclude it from the mode vote (coming soon).
                    </p>
                    <select value={vetoMode} onChange={e => setVetoMode(e.target.value)} className="veto-select">
                        <option value="">— no veto —</option>
                        {options.vetoModes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                </div>
                <div className="pref-actions">
                    <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</button>
                    {message && <span className={'pref-message' + (message.error ? ' error' : '')}>{message.text}</span>}
                </div>
            </form>
        </div>
    );
}

// ── Steam link panel ──────────────────────────────────────────────────────
function SteamCard({ profile, flags, onDemoLink = null }) {
    const [rank, setRank] = useState('');
    const [rankInvalid, setRankInvalid] = useState(false);
    const referral = useRef(null);

    if (profile.steam.linked) {
        return (
            <div className="profile-card">
                <h2>Steam</h2>
                <a className="steam-linked" href={profile.steam.profileUrl} target="_blank" rel="noopener noreferrer" title="Open Steam profile">
                    {profile.steam.avatar
                        ? <img className="steam-avatar" src={profile.steam.avatar} alt="" />
                        : <div className="steam-avatar hero-img-placeholder" />}
                    <div>
                        <div className="steam-status">✅ Steam linked</div>
                        <div className="steam-sub">{profile.steamName || 'Registered for Gargamel'} · open Steam profile ↗</div>
                    </div>
                </a>
            </div>
        );
    }

    if (!profile.isOwner) {
        return (
            <div className="profile-card">
                <h2>Steam</h2>
                <p className="pref-empty">This player hasn't linked a Steam account yet.</p>
            </div>
        );
    }

    const startLink = (e) => {
        e.preventDefault();
        if (!rank) { setRankInvalid(true); return; }
        if (onDemoLink) { onDemoLink(rank, referral.current || ''); return; }
        const params = new URLSearchParams({ rank, referredBy: referral.current || '' });
        window.location.href = '/api/auth/link-steam?' + params.toString();
    };

    return (
        <div className="profile-card">
            <h2>Link Steam &amp; register</h2>
            {flags.linkError && <div className="profile-banner error">Linking failed: {flags.linkError}</div>}
            <p className="pref-help">
                You're logged in, but not registered for the Gargamel League yet. Make sure your Steam account is
                added under <strong>Connections</strong> in your Discord settings, pick your rank, then link — this
                registers you and adds you to the Discord server.
            </p>
            <form onSubmit={startLink}>
                <RegistrationFields
                    rank={rank}
                    onRankChange={v => { setRank(v); setRankInvalid(false); }}
                    rankInvalid={rankInvalid}
                    onReferralChange={name => { referral.current = name; }}
                />
                <button type="submit" className="authenticate-button">Link Steam via Discord</button>
            </form>
        </div>
    );
}

export default function Profile({ accountId }) {
    const isMe = accountId == null;
    const auth = useAuth();
    const [profile, setProfile] = useState(null);
    const [status, setStatus] = useState('loading'); // loading | ok | notfound | unauth | error
    const [error, setError] = useState(null);
    const [flags, setFlags] = useState(takeUrlFlags);

    // ── Demo mode (/profile?demo=1): synthetic profile + control panel, no server writes
    const [demo] = useState(() => isMe && new URLSearchParams(window.location.search).get('demo') === '1');
    const [demoOptions, setDemoOptions] = useState(DEMO_DEFAULT_OPTIONS);
    const [demoPrefs, setDemoPrefs] = useState(null); // prefs after a simulated save
    const [demoLog, setDemoLog] = useState([]);
    const demoLogAdd = (line) => setDemoLog(l => [...l.slice(-7), line]);

    // The demo profile is derived during render (see `p` below) so cards that
    // remount on a toggle initialize from the new state, not the previous one.
    useEffect(() => {
        if (!demo) return;
        setStatus('ok');
        // The navbar shows the fake user when viewing as the owner
        auth.setDemoUser?.(demoOptions.viewer === 'owner' ? {
            displayName: 'DemoPlayer',
            avatarUrl: 'https://cdn.discordapp.com/embed/avatars/3.png',
            accountId: demoOptions.linked ? DEMO_ACCOUNT_ID : null,
            linked: !!demoOptions.linked,
        } : null);
    }, [demo, demoOptions, demoPrefs]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => () => { if (demo) auth.setDemoUser?.(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const demoSave = async (payload, { heroes, vetoModes }) => {
        demoLogAdd(`PUT /api/profile/prefs ${JSON.stringify(payload)}`);
        const list = heroes && heroes.length ? heroes : DEMO_HEROES;
        const modes = vetoModes && vetoModes.length ? vetoModes : DEMO_VETO_MODES;
        const prefs = {
            favHeroes: payload.favHeroes.map(id => heroById(id, list)),
            favPosition: payload.favPosition,
            vetoMode: payload.vetoMode != null ? (modes.find(m => m.id === payload.vetoMode) || null) : null,
        };
        setDemoPrefs(prefs);
        return buildDemoProfile(demoOptions, prefs);
    };

    const demoLink = (rank, referredBy) => {
        demoLogAdd(`GET /api/auth/link-steam?rank=${rank}&referredBy=${encodeURIComponent(referredBy)} -> Discord consent -> /api/auth/callback`);
        setDemoOptions(o => ({ ...o, linked: true }));
        setFlags({ linked: true, linkError: null, authError: null });
    };

    const demoChange = (next) => {
        setDemoOptions(next);
        setDemoPrefs(null);
        setFlags({ linked: false, linkError: null, authError: null });
    };

    const demoReset = () => { demoChange(DEMO_DEFAULT_OPTIONS); setDemoLog([]); };

    const load = useCallback(() => {
        if (demo) return;
        setStatus('loading');
        setError(null);
        const url = isMe ? '/api/profile/me' : `/api/players/${accountId}/profile`;
        fetch(url)
            .then(async res => {
                if (res.status === 401) { setStatus('unauth'); return; }
                if (res.status === 404) { setStatus('notfound'); return; }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                setProfile(await res.json());
                setStatus('ok');
            })
            .catch(err => { setError(err.message); setStatus('error'); });
    }, [isMe, accountId, demo]);

    useEffect(() => { load(); }, [load]);

    // If the session changes (logout) while on /profile, re-evaluate
    useEffect(() => {
        if (demo) return;
        if (isMe && !auth.loading && !auth.user) setStatus('unauth');
    }, [isMe, auth.loading, auth.user, demo]);

    if (status === 'loading') return <div className="page-content pc-profile"><Spinner label="Loading profile..." /></div>;

    if (status === 'unauth') {
        return (
            <div className="page-content pc-center">
                <div className="terminal-window">
                    <div className="auth-title">Log in to see your profile</div>
                    <div className="auth-description">Your profile shows your season stats, lets you pick favorite heroes and a position, and set a game-mode veto.</div>
                    {flags.authError && <div className="auth-warning">Login problem: {flags.authError}</div>}
                    {auth.enabled
                        ? <a className="authenticate-button" href={loginUrl('/profile')}>Login with Discord</a>
                        : <div className="auth-warning">Login isn't configured on this server yet.</div>}
                </div>
            </div>
        );
    }

    if (status === 'notfound') {
        return (
            <div className="page-content pc-profile">
                <div className="empty-state">
                    <h2>No such player</h2>
                    <p>We don't have any league data for this account.</p>
                </div>
            </div>
        );
    }

    if (status === 'error') {
        return <div className="page-content pc-profile"><ErrorBox message={`Failed to load profile: ${error}`} onRetry={load} /></div>;
    }

    const p = demo ? buildDemoProfile(demoOptions, demoPrefs) : profile;
    const season = p.season;

    return (
        <div className="page-content pc-profile">
            {demo && (
                <div className="demo-banner">
                    Demo mode — this is a synthetic profile. Use the panel to switch states; saves and the Steam link are simulated and nothing is written to the server.
                </div>
            )}
            {flags.linked && <div className="profile-banner ok">Steam linked — you're registered for the Gargamel League. Check Discord!</div>}

            <div className="profile-header">
                <div className="profile-avatars">
                    {p.discordAvatar
                        ? <img className="profile-avatar discord" src={p.discordAvatar} alt="" title="Discord avatar" />
                        : (p.steam.avatar
                            ? <img className="profile-avatar" src={p.steam.avatar} alt="" title="Steam avatar" />
                            : <div className="profile-avatar hero-img-placeholder" />)}
                </div>
                <div className="profile-identity">
                    <h1>{p.displayName}</h1>
                    <div className="profile-sub">
                        {p.steamName && p.steamName !== p.displayName && <span>Steam: {p.steamName}</span>}
                        {p.discordName && <span>Discord: @{p.discordName}</span>}
                        {p.prefs.favPosition && <span className="pref-chip small">{{ carry: 'Carry', mid: 'Mid', offlane: 'Offlane', soft_support: 'Soft Support', hard_support: 'Hard Support' }[p.prefs.favPosition]}</span>}
                    </div>
                    {season ? (
                        <div className="profile-stats">
                            <div className="stat"><strong>{season.wins}–{season.losses}</strong><span>Season {season.number} record</span></div>
                            <div className="stat"><strong>{pct(season.wins, season.matches)}</strong><span>Win rate</span></div>
                            <div className="stat"><strong>{season.kda.toFixed(2)}</strong><span>KDA</span></div>
                            <div className="stat"><strong>{Math.round(season.avgGPM)}</strong><span>Avg GPM</span></div>
                            <div className="stat"><strong>{season.mvpCount}</strong><span>MVP{season.mvpCount === 1 ? '' : 's'}</span></div>
                        </div>
                    ) : (
                        <div className="profile-nostats">No Season games on record yet.</div>
                    )}
                </div>
                <div className="profile-actions">
                    {p.opendotaUrl && (
                        <a className="btn btn-ghost" href={p.opendotaUrl} target="_blank" rel="noopener noreferrer">OpenDota profile ↗</a>
                    )}
                    {p.steam.linked && p.steam.profileUrl && (
                        <a className="btn btn-ghost" href={p.steam.profileUrl} target="_blank" rel="noopener noreferrer">Steam profile ↗</a>
                    )}
                </div>
            </div>

            <div className="profile-grid">
              <div className="profile-col">
                <div className="profile-card">
                    <h2>Top Heroes{season ? ` · Season ${season.number}` : ''}</h2>
                    {p.topHeroes.length ? (
                        <>
                            <p className="pref-help">Ranked by wins this season.</p>
                            <div className="top-heroes">
                                {p.topHeroes.map((h, i) => (
                                    <div key={h.id} className="top-hero">
                                        <div className="top-hero-rank">#{i + 1}</div>
                                        <HeroImg hero={h} className="top-hero-img" />
                                        <div className="top-hero-name">{h.name}</div>
                                        <div className="top-hero-stats">{h.wins}–{h.losses ?? (h.games - h.wins)} · {pct(h.wins, h.games)} win rate</div>
                                    </div>
                                ))}
                            </div>
                        </>
                    ) : <p className="pref-empty">No hero history yet — it fills in after the next season crawl.</p>}
                </div>

                <PreferencesCard
                    key={demo ? JSON.stringify(demoOptions) : 'live'}
                    profile={p}
                    onSaved={demo ? () => {} : setProfile}
                    saveHandler={demo ? demoSave : null}
                    fallbackHeroes={demo ? DEMO_HEROES : null}
                    fallbackVetoModes={demo ? DEMO_VETO_MODES : null}
                />
              </div>

              <div className="profile-col">
                <div className="profile-card">
                    <h2>Recent Matches</h2>
                    {p.recentMatches.length ? (
                        <ul className="recent-matches">
                            {p.recentMatches.map(m => (
                                <li key={m.matchId} className={m.won ? 'won' : 'lost'}>
                                    <HeroImg hero={m.hero} className="recent-hero-img" />
                                    <div className="recent-main">
                                        <div className="recent-line">
                                            <span className={'result ' + (m.won ? 'win' : 'loss')}>{m.won ? 'Win' : 'Loss'}</span>
                                            <span className="recent-hero-name">{m.hero?.name || 'Unknown hero'}</span>
                                            <span className="recent-kda">{m.kills}/{m.deaths}/{m.assists}</span>
                                        </div>
                                        <div className="recent-meta">
                                            {m.startTime ? <span>{formatMatchDate(m.startTime)}</span> : null}
                                            {m.duration ? <span>{formatDuration(m.duration)}</span> : null}
                                            {m.gameMode != null ? <span>{GAME_MODES[m.gameMode] || 'Mode ' + m.gameMode}</span> : null}
                                        </div>
                                    </div>
                                    <a className="od-link recent-od" href={`https://www.opendota.com/matches/${m.matchId}`} target="_blank" rel="noopener noreferrer" title="View match on OpenDota">↗</a>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="pref-empty">No matches on record yet.</p>}
                </div>

                <div className="profile-card">
                    <h2>Best Allies{season ? ` · Season ${season.number}` : ''}</h2>
                    {p.bestAllies && p.bestAllies.length ? (
                        <>
                            <p className="pref-help">Teammates with the most wins alongside {p.isOwner ? 'you' : p.displayName} this season.</p>
                            <ul className="allies">
                                {p.bestAllies.map(a => {
                                    const rate = a.games > 0 ? Math.round((a.wins / a.games) * 100) : 0;
                                    return (
                                        <li key={a.accountId}>
                                            {a.avatar
                                                ? <img className="ally-avatar" src={a.avatar} alt="" />
                                                : <div className="ally-avatar hero-img-placeholder" />}
                                            <div className="ally-main">
                                                <div className="ally-name"><PlayerLink name={a.name} accountId={a.accountId} /></div>
                                                <div className="ally-bar"><div className="ally-fill" style={{ width: rate + '%' }} /></div>
                                            </div>
                                            <div className="ally-record">
                                                <strong>{a.wins}–{a.losses}</strong>
                                                <span>{rate}% · {a.games} game{a.games === 1 ? '' : 's'}</span>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    ) : <p className="pref-empty">Not enough games together yet — allies appear after two or more shared wins or losses.</p>}
                </div>

                <SteamCard profile={p} flags={flags} onDemoLink={demo ? demoLink : null} />
              </div>
            </div>

            {demo && <ProfileDemoControls options={demoOptions} onChange={demoChange} onReset={demoReset} log={demoLog} />}
        </div>
    );
}
