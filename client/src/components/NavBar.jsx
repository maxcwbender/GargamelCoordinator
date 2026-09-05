import { Link, useRouter } from '../router.jsx';
import { useAuth, loginUrl } from '../auth.jsx';

const LINKS = [
    { to: '/', label: 'Home' },
    { to: '/matches', label: 'Matches' },
    { to: '/rankings', label: 'Rankings' },
    { to: '/about', label: 'About' },
    { to: '/livegame', label: 'Live Game' },
    { to: '/notifications', label: 'Notifications' },
];

// Top-right account area: Discord login when signed out, avatar + name (to the
// profile) and a logout button when signed in. Hidden entirely if the server
// has no Discord OAuth configured.
function AccountMenu() {
    const { loading, enabled, user, logout } = useAuth();
    const { path, navigate } = useRouter();

    if (loading || !enabled) return null;

    if (!user) {
        return (
            <a className="nav-login" href={loginUrl(path)}>
                <svg className="nav-discord-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M19.54 5.34A16.3 16.3 0 0 0 15.5 4l-.2.4a15 15 0 0 1 3.7 1.9 13.3 13.3 0 0 0-14 0 15 15 0 0 1 3.7-1.9L8.5 4a16.3 16.3 0 0 0-4.04 1.34C1.9 9.1 1.2 12.8 1.55 16.4a16.4 16.4 0 0 0 4.96 2.5l1.05-1.7a10.6 10.6 0 0 1-1.66-.8l.4-.3a11.7 11.7 0 0 0 11.4 0l.4.3c-.53.31-1.09.58-1.66.8l1.05 1.7a16.4 16.4 0 0 0 4.96-2.5c.41-4.17-.7-7.8-2.91-11.06ZM8.9 14.2c-.97 0-1.77-.9-1.77-2s.78-2 1.77-2 1.79.9 1.77 2c0 1.1-.78 2-1.77 2Zm6.2 0c-.97 0-1.77-.9-1.77-2s.78-2 1.77-2 1.79.9 1.77 2c0 1.1-.78 2-1.77 2Z" />
                </svg>
                <span>Login with Discord</span>
            </a>
        );
    }

    const onLogout = async () => {
        await logout();
        if (path === '/profile') navigate('/');
    };

    return (
        <div className="nav-account">
            <Link to="/profile" className={'nav-account-link' + (path === '/profile' ? ' active' : '')} title="My profile">
                {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="nav-avatar-fallback" />}
                <span className="nav-account-name">{user.displayName}</span>
            </Link>
            <button type="button" className="nav-logout" onClick={onLogout}>Logout</button>
        </div>
    );
}

// minimal: brand only, no page links or account (used by the summer-planning
// page, which deliberately isn't linked from the main site).
export default function NavBar({ minimal = false }) {
    const { path } = useRouter();
    return (
        <nav className="navbar">
            <Link to="/" className="navbar-brand">
                <img src="/GargamelPuppets.png" alt="Logo" />
                <span>Gargamel League</span>
            </Link>
            {!minimal && (
                <div className="navbar-right">
                    <ul className="navbar-links">
                        {LINKS.map(l => (
                            <li key={l.to}>
                                <Link to={l.to} className={path === l.to ? 'active' : undefined}>{l.label}</Link>
                            </li>
                        ))}
                    </ul>
                    <AccountMenu />
                </div>
            )}
        </nav>
    );
}
