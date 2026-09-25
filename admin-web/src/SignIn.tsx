import { useState, type FormEvent } from 'react';
import { api, storeToken } from './api';
import type { Admin } from './types';

interface SignInProps {
  onSignedIn: (admin: Admin) => void;
}

interface SessionResponse {
  token: string;
  expiresAt: string;
  admin: Admin;
}

export function SignIn({ onSignedIn }: SignInProps) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const session = await api<SessionResponse>('/admin/auth/session', {
        method: 'POST',
        anonymous: true,
        body: { login, password, totp },
      });

      storeToken(session.token);
      onSignedIn(session.admin);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connexion impossible.');
      // Un code ne sert qu'une fois : le laisser dans le champ ferait echouer
      // la deuxieme tentative pour une raison que rien n'explique a l'ecran.
      setTotp('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <form onSubmit={submit}>
        <h1>Questbook</h1>
        <p className="muted">Administration</p>

        <label>
          Identifiant
          <input
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          Mot de passe
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <label>
          Code d’authentification
          <input
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            required
          />
        </label>

        {error !== null && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || totp.length !== 6}>
          {busy ? 'Vérification…' : 'Entrer'}
        </button>
      </form>
    </main>
  );
}
