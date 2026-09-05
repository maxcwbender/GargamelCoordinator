import { useEffect, useRef, useState } from 'react';

export const RANKS = [
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

// Rank select + "referred by" autocomplete, shared by the home-page
// registration and the profile's "Link to Steam" panel. The referral is only
// reported once the user picks a real Discord member from the dropdown.
export default function RegistrationFields({ rank, onRankChange, rankInvalid, onReferralChange }) {
    const [members, setMembers] = useState([]);
    const [referralText, setReferralText] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const confirmed = useRef(null);

    useEffect(() => {
        fetch('/api/discord-members')
            .then(r => r.json())
            .then(list => setMembers(Array.isArray(list) ? list : []))
            .catch(() => {});
    }, []);

    const query = referralText.trim().toLowerCase();
    const matches = query.length >= 2
        ? members.filter(m => m.name.toLowerCase().includes(query)).slice(0, 20)
        : [];

    const setConfirmed = (name) => {
        confirmed.current = name;
        onReferralChange?.(name);
    };

    const pick = (name) => {
        setConfirmed(name);
        setReferralText(name);
        setDropdownOpen(false);
    };

    const onBlur = () => {
        setTimeout(() => {
            setDropdownOpen(false);
            if (!confirmed.current) setReferralText('');
        }, 150);
    };

    return (
        <>
            <div className="form-field">
                <label htmlFor="rank-select">Your Current Dota 2 Rank *</label>
                <select
                    id="rank-select"
                    className={'rank-select' + (rankInvalid ? ' invalid' : '')}
                    value={rank}
                    onChange={e => onRankChange(e.target.value)}
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
                    onChange={e => { setConfirmed(null); setReferralText(e.target.value); setDropdownOpen(true); }}
                    onBlur={onBlur}
                />
                {dropdownOpen && matches.length > 0 && (
                    <div className="referral-dropdown">
                        {matches.map(m => (
                            <div
                                key={m.name}
                                className="referral-option"
                                onMouseDown={e => { e.preventDefault(); pick(m.name); }}
                            >
                                {m.avatar && <img src={m.avatar} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                <span>{m.name}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
