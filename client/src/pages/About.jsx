import { Link } from '../router.jsx';

export default function About() {
    return (
        <div className="page-content pc-about">
            <div className="about-container">
                <h1>Gargamel Dota League</h1>
                <div className="about-subtitle">Community-Run Inhouse League</div>

                <div className="about-section">
                    <h2>What is Gargamel?</h2>
                    <p>
                        Gargamel League is an in-house Dota 2 Community.  Every game in Gargamel is organized
                        through our Discord Server where a Discord bot that handles matchmaking, team balancing, and lobby creation
                        automatically.
                    </p>
                </div>

                <div className="about-section">
                    <h2>Why is it called Gargamel?</h2>
                    <p>
                        Gargamel was the name of the man who hated and hunted down the Smurfs.  So we made a league based around
                        vouching and inviting friends to play in custom lobbies of 5v5 for fun, with no room for Smurfs.
                    </p>
                </div>

                <div className="about-section">
                    <h2>How It Works</h2>
                    <p>
                        Players register through our website by authenticating via Discord. Once registered,
                        the Discord Bot invites you to the Discord Server.  After the moderators and members vouch for you,
                        you can start queuing up for matches directly in Discord itself.  When enough players are ready,
                        the Bot automatically balances teams based on Players' ratings, creates a lobby in Dota 2 for
                        the match, and invites all players.  Wins and losses are tracked via the Bot and your Gargamel
                        MMR is adjusted for each match played.  As everyone knows, Garg MMR is more important than Ranked MMR.
                    </p>
                </div>

                <div className="about-section">
                    <h2>What's the Skill Level Like?</h2>
                    <p>
                        Gargamel MMRs range anywhere from Herald to Immortal with numerical number ranked.  The bot does its best
                        to balance matches to ensure everyone has a good time.  Over time, MMRs are adjusted by the system
                        as if you were playing a real Ranked game, keeping matchups dynamically fair.
                    </p>
                </div>

                <div className="about-section">
                    <h2>About The Bot</h2>
                    <ul className="feature-list">
                        <li>
                            <span className="feature-icon">+</span>
                            <span>Provides Automated matchmaking and team balancing based on player skill ratings</span>
                        </li>
                        <li>
                            <span className="feature-icon">+</span>
                            <span>Auto-creates Dota 2 lobbies, no manual lobby setup required.</span>
                        </li>
                        <li>
                            <span className="feature-icon">+</span>
                            <span>Fully Discord based.  Queue, voice chat, and meme away from one community location.</span>
                        </li>
                    </ul>
                </div>

                <div className="about-section">
                    <h2>Why play In-houses?</h2>
                    <p>
                        In-house leagues primarily provide a unique Community aspect to their matches compared to
                        pub matches or ranked Dota play.  Games are played exclusively among registered Discord
                        members of the Gargamel community, leading to better communication, and over time a community
                        and culture of memes built from the ground up to be enjoyable for everyone involved.
                    </p>
                </div>

                <div className="cta-box">
                    <p>Ready to join the Gargamel League? Register by authenticating via Discord.</p>
                    <Link to="/" className="cta-button">Register Now</Link>
                </div>
            </div>
        </div>
    );
}
