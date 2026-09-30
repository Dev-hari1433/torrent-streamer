'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { UserRound } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export default function AccountPanel() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [user, setUser] = useState<string | null>(null); const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setUser(data.session?.user.email ?? null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault(); if (!supabase) return; setBusy(true); setMessage('');
    try { const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) throw error; setOpen(false); setPassword(''); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="account"><button className="secondary compact" onClick={() => setOpen(!open)}><UserRound size={16} />{user ? 'Account' : 'Sign in'}</button>{open && <div className="account-popover panel">
    <h3>{user ?? 'Your cloud library'}</h3>
    {!supabase ? <p>Watch history and bookmarks are saved on this device. Configure Supabase to enable optional account sync.</p> : user ? <button className="secondary" onClick={() => { void supabase?.auth.signOut(); setOpen(false); }}>Sign out</button> : <form onSubmit={signIn}>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button><p>Use an account from your configured Supabase project.</p>
    </form>}{message && <p className="error" role="alert">{message}</p>}
  </div>}</div>;
}
