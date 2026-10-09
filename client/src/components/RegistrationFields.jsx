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

// Rank select shared by the home-page registration and the profile's "Link to
// Steam" panel. Referral attribution is not a form field: it comes from a hidden
// ?ref= tag on the link that brought the visitor here (see ../referral.js).
export default function RegistrationFields({ rank, onRankChange, rankInvalid }) {
    return (
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
    );
}
