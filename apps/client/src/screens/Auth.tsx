import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useSession } from '../state/session.js';
import { ErrorNote, Logo, Segmented, errorCopy } from '../shell/ui.js';

type Mode = 'login' | 'register';

export function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useSession((s) => s.setUser);
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'form' | 'guest' | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const finish = (user: Awaited<ReturnType<typeof api.login>>['user']) => {
    setUser(user);
    navigate(from, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('form');
    setError(null);
    try {
      const { user } =
        mode === 'login'
          ? await api.login(username, password)
          : await api.register(username, password);
      finish(user);
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setBusy(null);
    }
  };

  const guest = async () => {
    setBusy('guest');
    setError(null);
    try {
      const { user } = await api.guest();
      finish(user);
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="column">
      <div className="panel">
        <div className="auth-logo">
          <Logo size={200} />
        </div>
        <div className="auth-tabs">
          <Segmented<Mode>
            label="Sign in or create an account"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: 'login', label: 'Sign in' },
              { value: 'register', label: 'Create account' },
            ]}
          />
        </div>
        <form onSubmit={(e) => void submit(e)} className="stack">
          <label className="field">
            <span>Username</span>
            <input
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error ? true : undefined}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              aria-invalid={error ? true : undefined}
              required
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <button className="btn primary block lg" disabled={busy !== null}>
            {busy === 'form' ? (
              <span className="spinner inline dark" aria-label="Working" />
            ) : mode === 'login' ? (
              'Sign in'
            ) : (
              'Create account'
            )}
          </button>
        </form>
        <div className="divider labelled">or</div>
        <button className="btn block" onClick={() => void guest()} disabled={busy !== null}>
          {busy === 'guest' ? (
            <span className="spinner inline" aria-label="Working" />
          ) : (
            'Play as guest'
          )}
        </button>
        <p className="muted" style={{ marginTop: 16, textAlign: 'center' }}>
          {mode === 'register'
            ? 'New accounts start with 1000 mock $CHAIN.'
            : 'Guest accounts start with 1000 mock $CHAIN and cannot sign back in once the session ends.'}
        </p>
      </div>
    </div>
  );
}
