import { Link, useRouter } from '../router.jsx';

const LINKS = [
    { to: '/', label: 'Home' },
    { to: '/matches', label: 'Matches' },
    { to: '/rankings', label: 'Rankings' },
    { to: '/about', label: 'About' },
    { to: '/livegame', label: 'Live Game' },
    { to: '/notifications', label: 'Notifications' },
];

// minimal: brand only, no page links (used by the summer-planning page, which
// deliberately isn't linked from the main site).
export default function NavBar({ minimal = false }) {
    const { path } = useRouter();
    return (
        <nav className="navbar">
            <Link to="/" className="navbar-brand">
                <img src="/GargamelPuppets.png" alt="Logo" />
                <span>Gargamel League</span>
            </Link>
            {!minimal && (
                <ul className="navbar-links">
                    {LINKS.map(l => (
                        <li key={l.to}>
                            <Link to={l.to} className={path === l.to ? 'active' : undefined}>{l.label}</Link>
                        </li>
                    ))}
                </ul>
            )}
        </nav>
    );
}
