import { Router, useRouter } from './router.jsx';
import { AuthProvider } from './auth.jsx';
import NavBar from './components/NavBar.jsx';
import LiveGameToast from './components/LiveGameToast.jsx';
import Home from './pages/Home.jsx';
import About from './pages/About.jsx';
import Matches from './pages/Matches.jsx';
import Rankings from './pages/Rankings.jsx';
import LiveGame from './pages/LiveGame.jsx';
import Notifications from './pages/Notifications.jsx';
import SummerPlanning from './pages/SummerPlanning.jsx';
import Profile from './pages/Profile.jsx';
import PlayerAwards from './pages/PlayerAwards.jsx';

const PAGES = {
    '/': Home,
    '/about': About,
    '/matches': Matches,
    '/rankings': Rankings,
    '/livegame': LiveGame,
    '/notifications': Notifications,
    '/summer-planning': SummerPlanning,
};

function CurrentPage() {
    const { path } = useRouter();

    // Summer planning renders its own minimal chrome (brand-only navbar, no
    // live-game toast) — it's an unlisted page.
    if (path === '/summer-planning') {
        return (
            <>
                <NavBar minimal />
                <SummerPlanning />
            </>
        );
    }

    let page;
    const awardMatch = path.match(/^\/players\/(\d+)\/(mvps|svps)\/?$/);
    const playerMatch = path.match(/^\/players\/(\d+)\/?$/);
    if (awardMatch) {
        const award = awardMatch[2].slice(0, 3);
        page = <PlayerAwards key={award + awardMatch[1]} accountId={Number(awardMatch[1])} award={award} />;
    } else if (playerMatch) {
        page = <Profile key={playerMatch[1]} accountId={Number(playerMatch[1])} />;
    } else if (path === '/profile') {
        page = <Profile key="me" accountId={null} />;
    } else {
        const Page = PAGES[path] || Home; // unknown paths fall back to the home page
        page = <Page />;
    }

    return (
        <>
            <NavBar />
            {page}
            <LiveGameToast />
        </>
    );
}

export default function App() {
    return (
        <Router>
            <AuthProvider>
                <CurrentPage />
            </AuthProvider>
        </Router>
    );
}
