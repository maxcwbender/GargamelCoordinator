// Minimal history-based router: the site is seven fixed pages, so this stays a
// dependency-free ~50 lines instead of pulling in react-router.
import { createContext, useContext, useEffect, useState } from 'react';

const RouterContext = createContext({ path: '/', navigate: () => {} });

export function Router({ children }) {
    const [path, setPath] = useState(window.location.pathname);

    useEffect(() => {
        const onPop = () => setPath(window.location.pathname);
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const navigate = (to) => {
        if (to === path) return;
        window.history.pushState({}, '', to);
        setPath(to);
        window.scrollTo(0, 0);
    };

    return (
        <RouterContext.Provider value={{ path, navigate }}>
            {children}
        </RouterContext.Provider>
    );
}

export const useRouter = () => useContext(RouterContext);

export function Link({ to, children, ...rest }) {
    const { navigate } = useRouter();
    const onClick = (e) => {
        // Let modified clicks and middle clicks do the browser-default thing
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
    };
    return <a href={to} onClick={onClick} {...rest}>{children}</a>;
}
