import { Router, useRouter } from './router.jsx';
import NavBar from './components/NavBar.jsx';
import LiveGameToast from './components/LiveGameToast.jsx';
import Home from './pages/Home.jsx';
import About from './pages/About.jsx';
import Matches from './pages/Matches.jsx';
import Rankings from './pages/Rankings.jsx';
import LiveGame from './pages/LiveGame.jsx';
import Notifications from './pages/Notifications.jsx';
import SummerPlanning from './pages/SummerPlanning.jsx';

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

    const Page = PAGES[path] || Home; // unknown paths fall back to the home page
    return (
        <>
            <NavBar />
            <Page />
            <LiveGameToast />
        </>
    );
}

export default function App() {
    return (
        <Router>
            <CurrentPage />
        </Router>
    );
}
