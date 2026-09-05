// Login state for the whole app, backed by the session cookie via /api/auth/me.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const AuthContext = createContext({ loading: true, enabled: false, user: null, refresh: () => {}, logout: () => {} });

export function AuthProvider({ children }) {
    const [state, setState] = useState({ loading: true, enabled: false, user: null });

    const refresh = useCallback(async () => {
        try {
            const res = await fetch('/api/auth/me');
            const data = await res.json();
            setState({ loading: false, enabled: !!data.enabled, user: data.user || null });
        } catch {
            setState({ loading: false, enabled: false, user: null });
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // Demo pages (/profile?demo=1) can present a fake logged-in user so the
    // navbar account menu can be exercised without a real session.
    const [demoUser, setDemoUser] = useState(null);

    const logout = useCallback(async () => {
        if (demoUser) { setDemoUser(null); return; }
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
        setState(s => ({ ...s, user: null }));
    }, [demoUser]);

    const value = demoUser
        ? { ...state, loading: false, enabled: true, user: demoUser, refresh, logout, setDemoUser }
        : { ...state, refresh, logout, setDemoUser };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);

// Where to send the browser to start a Discord login; returns to the given path.
export const loginUrl = (returnTo) =>
    '/api/auth/login?returnTo=' + encodeURIComponent(returnTo || window.location.pathname || '/');
