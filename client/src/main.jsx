import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import './styles/base.css';
import './styles/home.css';
import './styles/about.css';
import './styles/matches.css';
import './styles/rankings.css';
import './styles/livegame.css';
import './styles/notifications.css';
import './styles/summer-planning.css';
import './styles/profile.css';
import './styles/minimap-calibrator.css';

createRoot(document.getElementById('root')).render(<App />);
