// Floating control panel for /profile?demo=1: flips the synthetic profile
// between the states a real player could be in.
export default function ProfileDemoControls({ options, onChange, onReset, log }) {
    const set = (key, value) => onChange({ ...options, [key]: value });
    const Toggle = ({ k, label, hint }) => (
        <label className="demo-toggle">
            <input type="checkbox" checked={!!options[k]} onChange={e => set(k, e.target.checked)} />
            <span>{label}</span>
            {hint && <small>{hint}</small>}
        </label>
    );

    return (
        <aside className="demo-panel">
            <div className="demo-panel-title">Profile demo</div>
            <p className="demo-panel-note">Nothing here touches the server — saves and the Steam link are simulated.</p>

            <div className="demo-group">
                <div className="demo-group-title">Viewing as</div>
                <label className="demo-radio">
                    <input type="radio" name="viewer" checked={options.viewer === 'owner'} onChange={() => set('viewer', 'owner')} />
                    the player (owner — can edit)
                </label>
                <label className="demo-radio">
                    <input type="radio" name="viewer" checked={options.viewer === 'visitor'} onChange={() => set('viewer', 'visitor')} />
                    someone else (read-only)
                </label>
            </div>

            <div className="demo-group">
                <div className="demo-group-title">Player state</div>
                <Toggle k="linked" label="Steam linked" hint="registered in the users table" />
                <Toggle k="hasStats" label="Has Season games" hint="stats, top heroes, recent matches" />
                <Toggle k="hasPrefs" label="Preferences set" hint="favorite heroes / position / veto" />
                <Toggle k="hasAccount" label="Has logged in before" hint="Discord name + avatar known" />
            </div>

            <div className="demo-actions">
                <button type="button" className="btn btn-sm btn-ghost" onClick={onReset}>Reset demo</button>
            </div>

            {log.length > 0 && (
                <div className="demo-log">
                    <div className="demo-group-title">Simulated requests</div>
                    {log.map((entry, i) => <div key={i} className="demo-log-line">{entry}</div>)}
                </div>
            )}
        </aside>
    );
}
