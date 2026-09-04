import { useEffect, useRef, useState } from 'react';

const OAUTH_URL = 'https://discord.com/oauth2/authorize?client_id=822929136711893063&response_type=token&redirect_uri=http%3A%2F%2Fwww.gargamel-league.com%2F&scope=identify+connections+guilds.join';

const RANKS = [
    ['Rusty', "I'm rusty or don't know my rank"],
    ['Herald', 'Herald'],
    ['Guardian', 'Guardian'],
    ['Crusader', 'Crusader'],
    ['Archon', 'Archon'],
    ['Legend', 'Legend'],
    ['Ancient', 'Ancient'],
    ['Divine', 'Divine'],
    ['Immortal', 'Immortal'],
];

// Registration page. Two phases:
//   1. No OAuth token in the URL fragment -> show the rank/referral form; the
//      button stores selections in sessionStorage and sends the user to Discord.
//   2. Discord redirected back with #access_token -> PUT the registration to
//      the backend and show success/failure.
export default function Home() {
    const [state, setState] = useState('init'); // init | auth | loading | success | error
    const [errorMessage, setErrorMessage] = useState('There was a problem linking your accounts. Please try again.');
    const [rank, setRank] = useState('');
    const [rankInvalid, setRankInvalid] = useState(false);
    const [members, setMembers] = useState([]);
    const [referralText, setReferralText] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const confirmedReferral = useRef(null);

    useEffect(() => {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const accessToken = fragment.get('access_token');
        const tokenType = fragment.get('token_type');

        if (!accessToken) {
            setState('auth');
            fetch('/api/discord-members')
                .then(r => r.json())
                .then(list => setMembers(Array.isArray(list) ? list : []))
                .catch(() => {});
            return;
        }

        setState('loading');

        // Retrieve the rank and referral that were selected before OAuth
        const selectedRank = sessionStorage.getItem('selectedRank');
        const referredBy = sessionStorage.getItem('referredBy');
        sessionStorage.removeItem('selectedRank');
        sessionStorage.removeItem('referredBy');

        fetch('/', {
            method: 'PUT',
            body: JSON.stringify({ accessToken, tokenType, rank: selectedRank, referredBy: referredBy || undefined }),
            headers: { 'Content-Type': 'application/json' }
        }).then(async response => {
            const data = await response.json().catch(() => ({}));
            if (response.ok) {
                setState('success');
            } else {
                console.error('Backend returned an error during processing:', data);
                const msg = data?.result || `HTTP ${response.status}`;
                setErrorMessage(`There was a problem linking your accounts:\n\n${msg}`);
                setState('error');
            }
        }).catch(err => {
            console.error('Networking or fetch error: ', err);
            setErrorMessage(`Network error: ${err.message}`);
            setState('error');
        });
    }, []);

    const query = referralText.trim().toLowerCase();
    const matches = query.length >= 2
        ? members.filter(m => m.name.toLowerCase().includes(query)).slice(0, 20)
        : [];

    const pickReferral = (name) => {
        confirmedReferral.current = name;
        setReferralText(name);
        setDropdownOpen(false);
    };

    const onReferralBlur = () => {
        setTimeout(() => {
            setDropdownOpen(false);
            if (!confirmedReferral.current) setReferralText('');
        }, 150);
    };

    const onRegisterClick = (e) => {
        if (!rank) {
            e.preventDefault();
            alert('Please select your Dota 2 rank before registering!');
            setRankInvalid(true);
            return;
        }
        // Store rank and referral in sessionStorage so we can retrieve them after OAuth redirect
        sessionStorage.setItem('selectedRank', rank);
        sessionStorage.setItem('referredBy', confirmedReferral.current || '');
    };

    return (
        <div className="page-content pc-center">
            <div className="terminal-window">
                <div className="system-header">
                    <div className="logo-title">Gargamel Dota League</div>
                    <img className="logo-image" src="/GargamelPuppets.png" alt="Gargamel League Logo" />
                </div>

                {state === 'auth' && (
                    <div>
                        <div className="auth-title">Account Link Required</div>
                        <div className="auth-description">
                            To participate in Gargamel League matches, you need to link your Discord account to your Steam account.<br /><br />
                            Select your current rank then click the button below to authenticate and join the Gargamel Discord Server.
                        </div>
                        <div className="auth-warning">
                            Warning: Before clicking the link, please ensure your Discord User Settings have your Steam Account added under Connections
                        </div>
                        <div className="form-field">
                            <label htmlFor="rank-select">Your Current Dota 2 Rank *</label>
                            <select
                                id="rank-select"
                                className={'rank-select' + (rankInvalid ? ' invalid' : '')}
                                value={rank}
                                onChange={e => { setRank(e.target.value); setRankInvalid(false); }}
                            >
                                <option value="">-- Select Your Rank --</option>
                                {RANKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </div>
                        <div className="form-field referral-wrap">
                            <label htmlFor="referral-input">Referred By (optional)</label>
                            <input
                                id="referral-input"
                                type="text"
                                autoComplete="off"
                                placeholder="Start typing a Discord name..."
                                value={referralText}
                                onChange={e => { confirmedReferral.current = null; setReferralText(e.target.value); setDropdownOpen(true); }}
                                onBlur={onReferralBlur}
                            />
                            {dropdownOpen && matches.length > 0 && (
                                <div className="referral-dropdown">
                                    {matches.map(m => (
                                        <div
                                            key={m.name}
                                            className="referral-option"
                                            onMouseDown={e => { e.preventDefault(); pickReferral(m.name); }}
                                        >
                                            {m.avatar && <img src={m.avatar} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                            <span>{m.name}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <a className="authenticate-button" href={OAUTH_URL} onClick={onRegisterClick}>
                            Register for the Gargamel League
                        </a>
                    </div>
                )}

                {state === 'loading' && (
                    <div>
                        <div className="loading-title">🔄 Processing...</div>
                        <div className="status-message">Please wait while we verify your connection.</div>
                    </div>
                )}

                {state === 'success' && (
                    <div>
                        <div className="success-title">✅ Connection Successful</div>
                        <div className="status-message">Check your Discord for access to the Gargamel League server.</div>
                    </div>
                )}

                {state === 'error' && (
                    <div>
                        <div className="error-title">❌ Connection Failed</div>
                        <div className="status-message">{errorMessage}</div>
                        <button className="authenticate-button" onClick={() => window.location.reload()}>Retry</button>
                    </div>
                )}
            </div>
        </div>
    );
}
