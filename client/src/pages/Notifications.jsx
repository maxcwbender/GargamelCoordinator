import { useEffect, useState } from 'react';

// Queue-notification signup page, powered by ntfy. The topic comes from the
// backend (/api/ntfy-info) so the repo never pins it.
export default function Notifications() {
    const [info, setInfo] = useState(null); // { server, topic }
    const [unavailable, setUnavailable] = useState(false);
    const [copyLabel, setCopyLabel] = useState('Copy');
    const [iosButtonLabel, setIosButtonLabel] = useState(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/ntfy-info');
                if (!res.ok) throw new Error('not configured');
                setInfo(await res.json());
            } catch {
                setUnavailable(true);
            }
        })();
    }, []);

    const copyTopic = async () => {
        try {
            await navigator.clipboard.writeText(info.topic);
            return true;
        } catch {
            return false;
        }
    };

    let signupArea = null;
    if (info) {
        const { server, topic } = info;
        const host = server.replace(/^https?:\/\//, '');

        // Only the ANDROID ntfy app registers the ntfy:// scheme; the iOS app has no
        // subscribe deep link, so there the best we can do is copy the topic and walk
        // the player through pasting it into the app. Desktop goes to the web app.
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isAndroid = /Android/.test(navigator.userAgent);

        // On our own ntfy server, subscribers must point the app at it too — the
        // apps default to ntfy.sh.
        const isDefaultServer = host === 'ntfy.sh';

        let button;
        let subscribeStep;
        if (isAndroid) {
            button = <a className="signup-button" href={`ntfy://${host}/${topic}`}>Sign up for queue notifications</a>;
            subscribeStep = <li>Tap the button above to subscribe. If it doesn't work, add a subscription in the app manually with this topic:</li>;
        } else if (isIOS) {
            const onIosClick = async (e) => {
                e.preventDefault();
                const ok = await copyTopic();
                setIosButtonLabel(ok ? 'Topic copied! Now open ntfy → + → paste' : 'Copy failed. Long-press the topic below');
            };
            button = <a className="signup-button" href="#" onClick={onIosClick}>{iosButtonLabel || 'Copy topic to subscribe'}</a>;
            subscribeStep = (
                <li>
                    Tap the button above to copy the topic, then open the ntfy app, tap + to add a subscription, and paste the topic name
                    {isDefaultServer ? ':' : `. Turn on "Use another server" and enter ${server}:`}
                </li>
            );
        } else {
            button = <a className="signup-button" href={`${server}/${topic}`} target="_blank" rel="noopener noreferrer">Sign up for queue notifications</a>;
            subscribeStep = <li>Tap the button above to subscribe. If it doesn't work, add a subscription in the app manually with this topic:</li>;
        }

        const onCopyClick = async () => {
            setCopyLabel((await copyTopic()) ? 'Copied!' : 'Select it');
            setTimeout(() => setCopyLabel('Copy'), 2000);
        };

        signupArea = (
            <div>
                {button}
                <div className="steps">
                    <ol>
                        <li>Install ntfy:{' '}
                            <a href="https://apps.apple.com/us/app/ntfy/id1625396347" target="_blank" rel="noopener noreferrer">iOS</a> ·{' '}
                            <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener noreferrer">Android</a>
                        </li>
                        {subscribeStep}
                    </ol>
                </div>
                <div className="topic-row">
                    <div className="topic-box">{topic}</div>
                    <button className="copy-button" type="button" onClick={onCopyClick}>{copyLabel}</button>
                </div>
                {!isDefaultServer && (
                    <p className="fine-print">This topic lives on our own server: {server}</p>
                )}
                <p className="fine-print">
                    No phone? You can also get notifications in your browser:{' '}
                    <a href={`${server}/${topic}`} target="_blank" rel="noopener noreferrer">subscribe on the ntfy web app</a>.
                </p>
            </div>
        );
    }

    return (
        <div className="page-content pc-center">
            <div className="notif-card">
                <div className="notif-card-title">🔔 Queue Notifications</div>
                <p className="notif-card-description">
                    Get a push notification on your phone when the Gargamel Queue is filling up
                    (8, 9, and 10 players) and when a ready check fires, so you never miss a game.
                    Powered by the free ntfy app.
                </p>
                {unavailable && (
                    <div className="notif-card-description">
                        Notifications aren't configured right now. Check back later.
                    </div>
                )}
                {signupArea}
            </div>
        </div>
    );
}
