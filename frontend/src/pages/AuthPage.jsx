import { useEffect, useRef, useState } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { api } from '../api/client';

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

export default function AuthPage({ onAuth }) {
  const googleButtonRef = useRef(null);
  const [mode, setMode] = useState('login');
  const [role, setRole] = useState('user');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function storeAuth(payload) {
    localStorage.setItem('sdc-auth-token', payload.token);
    localStorage.setItem('sdc-auth-user', JSON.stringify(payload.user));
    onAuth(payload.user);
  }

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const endpoint = mode === 'signup' ? '/auth/signup' : '/auth/login';
      const response = await api.post(endpoint, { ...form, role });
      storeAuth(response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!googleClientId || !googleButtonRef.current) return;

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (credentialResponse) => {
          try {
            const response = await api.post('/auth/google', {
              credential: credentialResponse.credential,
              role,
            });
            storeAuth(response.data);
          } catch (requestError) {
            setError(requestError.response?.data?.message || 'Google sign-in failed.');
          }
        },
      });
      window.google?.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        width: 280,
      });
    };
    document.body.appendChild(script);

    return () => {
      script.remove();
    };
  }, [role]);

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Secure Access</p>
        <h1>{mode === 'signup' ? 'Create account' : 'Login'}</h1>
        <p>Use a participant account for recordings or an admin account to review all submissions.</p>

        <div className="segmented">
          <button className={role === 'user' ? 'active' : ''} type="button" onClick={() => setRole('user')}>
            User
          </button>
          <button className={role === 'admin' ? 'active' : ''} type="button" onClick={() => setRole('admin')}>
            Admin
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          {mode === 'signup' && (
            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            />
          </label>

          {error && <p className="error">{error}</p>}

          <button className="primary" type="submit" disabled={loading}>
            {mode === 'signup' ? <UserPlus size={18} /> : <LogIn size={18} />}
            {loading ? 'Please wait...' : mode === 'signup' ? 'Sign Up' : 'Login'}
          </button>
        </form>

        <div className="auth-divider">or</div>
        {googleClientId ? <div ref={googleButtonRef} /> : <p className="inline-status">Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in.</p>}

        <button className="text-button" type="button" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
          {mode === 'signup' ? 'Already have an account? Login' : 'Need an account? Sign up'}
        </button>
      </section>
    </main>
  );
}
