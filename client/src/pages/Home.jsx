import { useEffect, useRef, useState } from 'react';
import RegistrationFields from '../components/RegistrationFields.jsx';

const OAUTH_URL = 'https://discord.com/oauth2/authorize?client_id=822929136711893063&response_type=token&redirect_uri=http%3A%2F%2Fwww.gargamel-league.com%2F&scope=identify+connections+guilds.join';

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
    const [authError] = useState(() => new URLSearchParams(window.location.search).get('authError'));
    const confirmedReferral = useRef(null);

    useEffect(() => {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const accessToken = fragment.get('access_token');
        const tokenType = fragment.get('token_type');

        if (!accessToken) {
            setState('auth');
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

                {authError && <div className="auth-warning">Login problem: {authError}</div>}

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
                        <RegistrationFields
                            rank={rank}
                            onRankChange={v => { setRank(v); setRankInvalid(false); }}
                            rankInvalid={rankInvalid}
                            onReferralChange={name => { confirmedReferral.current = name; }}
                        />
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
