import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api, apiForm, errorMessage } from './api';
import { Branding, Logo, useBranding } from './branding';
import { LinkDetail, LinksList, NewLink } from './Links';
import { LinkStats, StatsOverview, VisitorDetail } from './Stats';
import { ThemePref, applyTheme } from './theme';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  theme: ThemePref;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  totpRequired: boolean;
}

function Alert({ kind, children }: { kind?: 'bad' | 'ok'; children: ReactNode }) {
  return <div className={`alert ${kind ?? ''}`}>{children}</div>;
}

function AuthBox({ title, children }: { title: string; children: ReactNode }) {
  const { siteName } = useBranding();
  return (
    <div className="auth">
      <div className="box">
        <div className="logo">
          <Logo />
          <span className="nm">{siteName}</span>
        </div>
        <div className="card stack">
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ---------- root ---------- */
export function App() {
  const [state, setState] = useState<{ loading: boolean; user: User | null; needsSetup: boolean; tokenRequired: boolean }>({
    loading: true,
    user: null,
    needsSetup: false,
    tokenRequired: false,
  });

  const refresh = useCallback(async () => {
    const [me, setup] = await Promise.all([
      api<{ user: User | null }>('GET', '/me'),
      api<{ needsSetup: boolean; tokenRequired: boolean }>('GET', '/setup/status').catch(() => ({ needsSetup: false, tokenRequired: false })),
    ]);
    if (me.user) applyTheme(me.user.theme);
    setState({ loading: false, user: me.user, needsSetup: setup.needsSetup, tokenRequired: setup.tokenRequired });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.loading) return <div className="auth muted">Loading…</div>;
  if (state.needsSetup) return <Setup tokenRequired={state.tokenRequired} onDone={refresh} />;
  if (!state.user) return <Login onDone={refresh} />;
  if (state.user.mustChangePassword) return <ForceChange user={state.user} onDone={refresh} />;
  return <Shell user={state.user} refresh={refresh} />;
}

/* ---------- auth screens ---------- */
function Setup({ tokenRequired, onDone }: { tokenRequired: boolean; onDone: () => Promise<void> }) {
  const { refresh: refreshBranding } = useBranding();
  const [f, setF] = useState({ displayName: '', email: '', password: '', token: '', siteName: 'Docs' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/setup', { ...f, token: f.token || undefined });
      await refreshBranding();
      await onDone();
    } catch (x) {
      setErr(errorMessage(x));
      setBusy(false);
    }
  }
  return (
    <AuthBox title="First-time setup">
      <p className="muted">Create the admin account. This screen only appears once.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label>System name (shown in the header, sign-in page and shared documents)</label>
          <input value={f.siteName} maxLength={60} onChange={(e) => setF({ ...f, siteName: e.target.value })} required />
        </div>
        <div>
          <label>Full name</label>
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />
        </div>
        <div>
          <label>Email</label>
          <input type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </div>
        <div>
          <label>Password (at least 10 characters, letters and numbers)</label>
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </div>
        {tokenRequired && (
          <div>
            <label>Setup token</label>
            <input value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required />
          </div>
        )}
        {err && <Alert kind="bad">{err}</Alert>}
        <button className="primary" disabled={busy}>
          Create admin account
        </button>
      </form>
    </AuthBox>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [f, setF] = useState({ email: '', password: '', totp: '' });
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/login', { email: f.email, password: f.password, totp: f.totp || undefined });
      await onDone();
    } catch (x) {
      if (x instanceof ApiError && x.code === 'totp_required') {
        setNeedTotp(true);
      } else {
        setErr(errorMessage(x));
      }
      setBusy(false);
    }
  }
  return (
    <AuthBox title="Sign in">
      <form className="stack" onSubmit={submit}>
        <div>
          <label>Email</label>
          <input type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoFocus />
        </div>
        <div>
          <label>Password</label>
          <input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </div>
        {needTotp && (
          <div>
            <label>Verification code (6 digits)</label>
            <input inputMode="numeric" autoComplete="one-time-code" value={f.totp} onChange={(e) => setF({ ...f, totp: e.target.value })} required autoFocus />
          </div>
        )}
        {err && <Alert kind="bad">{err}</Alert>}
        <button className="primary" disabled={busy}>
          {needTotp ? 'Verify and sign in' : 'Sign in'}
        </button>
      </form>
    </AuthBox>
  );
}

function ForceChange({ user, onDone }: { user: User; onDone: () => Promise<void> }) {
  return (
    <AuthBox title="Choose a new password">
      <p className="muted">Hi {user.displayName}. You need to replace your temporary password before continuing.</p>
      <PasswordForm onDone={onDone} />
      <button
        onClick={async () => {
          await api('POST', '/logout');
          await onDone();
        }}
      >
        Sign out
      </button>
    </AuthBox>
  );
}

function PasswordForm({ onDone }: { onDone?: () => Promise<void> }) {
  const [f, setF] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('POST', '/me/password', f);
      setF({ current: '', next: '' });
      setMsg({ ok: true, text: 'Password changed.' });
      await onDone?.();
    } catch (x) {
      setMsg({ ok: false, text: errorMessage(x) });
    }
    setBusy(false);
  }
  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <label>Current password</label>
        <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
      </div>
      <div>
        <label>New password (at least 10 characters, letters and numbers)</label>
        <input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
      </div>
      {msg && <Alert kind={msg.ok ? 'ok' : 'bad'}>{msg.text}</Alert>}
      <button className="primary" disabled={busy}>
        Change password
      </button>
    </form>
  );
}

/* ---------- shell ---------- */
const icons = {
  plus: <path d="M12 5v14M5 12h14" />,
  stats: <path d="M5 20V10M12 20V4M19 20v-7" />,
  links: <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />,
  users: <path d="M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0" />,
  audit: <path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3" />,
  settings: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6" />,
  account: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
};
function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {icons[name]}
    </svg>
  );
}

function Shell({ user, refresh }: { user: User; refresh: () => Promise<void> }) {
  const admin = user.role === 'admin';
  const { siteName } = useBranding();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <Logo />
          <span>{siteName}</span>
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {user.displayName}
        </span>
      </header>
      <nav className="nav">
        <NavLink to="/" end>
          <Icon name="links" />
          Links
        </NavLink>
        <NavLink to="/new">
          <Icon name="plus" />
          New
        </NavLink>
        <NavLink to="/stats">
          <Icon name="stats" />
          Stats
        </NavLink>
        {admin && (
          <NavLink to="/users">
            <Icon name="users" />
            Users
          </NavLink>
        )}
        {admin && (
          <NavLink to="/audit">
            <Icon name="audit" />
            Activity
          </NavLink>
        )}
        {admin && (
          <NavLink to="/settings">
            <Icon name="settings" />
            Settings
          </NavLink>
        )}
        <NavLink to="/account">
          <Icon name="account" />
          Account
        </NavLink>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<LinksList admin={admin} />} />
          <Route path="/new" element={<NewLink />} />
          <Route path="/links/:id" element={<LinkDetail />} />
          <Route path="/links/:id/stats" element={<LinkStats />} />
          <Route path="/links/:id/visitors/:key" element={<VisitorDetail />} />
          <Route path="/stats" element={<StatsOverview admin={admin} />} />
          <Route path="/users" element={admin ? <Users me={user} /> : <Navigate to="/" />} />
          <Route path="/audit" element={admin ? <Audit /> : <Navigate to="/" />} />
          <Route path="/settings" element={admin ? <Settings /> : <Navigate to="/" />} />
          <Route path="/account" element={<Account user={user} refresh={refresh} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

/* ---------- users (admin) ---------- */
interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  isActive: boolean;
  totpEnabled: boolean;
  totpRequired: boolean;
  lastLoginAt: string | null;
}

function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: ReactNode } | null>(null);
  const [f, setF] = useState({ displayName: '', email: '', role: 'user' });
  const load = useCallback(async () => setUsers((await api<{ users: UserRow[] }>('GET', '/users')).users), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (x) {
      setMsg({ ok: false, text: errorMessage(x) });
    }
  };
  const showTemp = (who: string, pw: string) =>
    setMsg({
      ok: true,
      text: (
        <>
          Temporary password for <b>{who}</b> (shown only once; it must be changed at first sign-in):
          <div className="secret">{pw}</div>
        </>
      ),
    });

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ tempPassword: string }>('POST', '/users', f);
      showTemp(f.email, r.tempPassword);
      setF({ displayName: '', email: '', role: 'user' });
    });
  }

  return (
    <>
      <h1>Users</h1>
      {msg && <Alert kind={msg.ok ? 'ok' : 'bad'}>{msg.text}</Alert>}
      <form className="card stack" onSubmit={create} style={{ marginTop: 12 }}>
        <h2>New user</h2>
        <div>
          <label>Full name</label>
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />
        </div>
        <div>
          <label>Email</label>
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </div>
        <div>
          <label>Role</label>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button className="primary">Create (a temporary password is generated)</button>
      </form>

      {users.map((u) => (
        <div className="card user" key={u.id}>
          <div className="row between">
            <b>{u.displayName}</b>
            <span>
              <span className={`badge ${u.role === 'admin' ? 'admin' : ''}`}>{u.role === 'admin' ? 'Admin' : 'User'}</span>{' '}
              {!u.isActive && <span className="badge off">Disabled</span>} {u.totpEnabled && <span className="badge">2FA</span>}
            </span>
          </div>
          <div className="muted">{u.email}</div>
          <div className="muted num" style={{ fontSize: '0.8rem' }}>
            Last sign-in: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-US') : '—'}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="small"
              onClick={() => run(async () => showTemp(u.email, (await api<{ tempPassword: string }>('POST', `/users/${u.id}/reset-password`)).tempPassword))}
            >
              Reset password
            </button>
            {u.totpEnabled && (
              <button className="small" onClick={() => run(async () => void (await api('POST', `/users/${u.id}/reset-2fa`)))}>
                Reset 2FA
              </button>
            )}
            <button className="small" onClick={() => run(async () => void (await api('PATCH', `/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' })))}>
              {u.role === 'admin' ? 'Make user' : 'Make admin'}
            </button>
            {u.id !== me.id && (
              <button className="small" onClick={() => run(async () => void (await api('PATCH', `/users/${u.id}`, { isActive: !u.isActive })))}>
                {u.isActive ? 'Disable' : 'Enable'}
              </button>
            )}
            {u.id !== me.id && (
              <button
                className="small danger"
                onClick={() => {
                  if (confirm(`Permanently delete ${u.email} and all of their links?`)) void run(async () => void (await api('DELETE', `/users/${u.id}`)));
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------- activity log (admin) ---------- */
function Audit() {
  const [entries, setEntries] = useState<{ id: number; action: string; actorEmail: string | null; targetType: string | null; at: string; detail: unknown }[]>([]);
  useEffect(() => {
    void api<{ entries: typeof entries }>('GET', '/audit?limit=100').then((r) => setEntries(r.entries));
  }, []);
  return (
    <>
      <h1>Activity log</h1>
      <div className="card">
        {entries.length === 0 && <div className="empty">No entries.</div>}
        {entries.map((e) => (
          <div className="audit-row" key={e.id}>
            <b>{e.action}</b> <span className="muted">· {e.actorEmail ?? 'system'}</span>
            <div className="muted num" style={{ fontSize: '0.8rem' }}>
              {new Date(e.at).toLocaleString('en-US')}
              {e.detail ? ` · ${JSON.stringify(e.detail)}` : ''}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- account ---------- */
function Account({ user, refresh }: { user: User; refresh: () => Promise<void> }) {
  const [name, setName] = useState(user.displayName);
  const [msg, setMsg] = useState('');

  async function setTheme(theme: ThemePref) {
    applyTheme(theme);
    await api('PATCH', '/me', { theme });
    await refresh();
  }
  async function saveName(e: FormEvent) {
    e.preventDefault();
    await api('PATCH', '/me', { displayName: name });
    setMsg('Saved.');
    await refresh();
  }

  return (
    <>
      <h1>Account</h1>
      <div className="card stack">
        <h2>Theme</h2>
        <div className="seg" role="group" aria-label="Theme">
          {(['dark', 'light', 'system'] as ThemePref[]).map((t) => (
            <button key={t} className={user.theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
              {t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}
            </button>
          ))}
        </div>
      </div>
      <form className="card stack" onSubmit={saveName}>
        <h2>Profile</h2>
        <div className="muted">
          {user.email} · {user.role === 'admin' ? 'Admin' : 'User'}
        </div>
        <div>
          <label>Full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        {msg && <Alert kind="ok">{msg}</Alert>}
        <button>Save</button>
      </form>
      <div className="card stack">
        <h2>Password</h2>
        <PasswordForm />
      </div>
      <TwoFactor user={user} refresh={refresh} />
      <div className="card">
        <button
          className="danger"
          onClick={async () => {
            await api('POST', '/logout');
            await refresh();
          }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}

function TwoFactor({ user, refresh }: { user: User; refresh: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fail = (x: unknown) => setMsg({ ok: false, text: errorMessage(x) });

  return (
    <div className="card stack">
      <h2>Two-factor authentication (2FA)</h2>
      <p className="muted">Optional. Works with any authenticator app (Google Authenticator, Authy, 1Password…).</p>
      {msg && <Alert kind={msg.ok ? 'ok' : 'bad'}>{msg.text}</Alert>}
      {!user.totpEnabled && !setup && (
        <button
          className="primary"
          onClick={async () => {
            try {
              setMsg(null);
              setSetup(await api('POST', '/me/2fa/setup'));
            } catch (x) {
              fail(x);
            }
          }}
        >
          Enable 2FA
        </button>
      )}
      {setup && (
        <div className="stack">
          <p>Scan the QR code with your authenticator app, or enter the key manually:</p>
          <img src={setup.qr} alt="2FA QR code" width={220} height={220} style={{ background: '#fff', borderRadius: 8 }} />
          <div className="secret">{setup.secret}</div>
          <div>
            <label>6-digit code from the app</label>
            <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <button
            className="primary"
            onClick={async () => {
              try {
                await api('POST', '/me/2fa/enable', { code });
                setSetup(null);
                setCode('');
                setMsg({ ok: true, text: '2FA enabled.' });
                await refresh();
              } catch (x) {
                fail(x);
              }
            }}
          >
            Verify and enable
          </button>
        </div>
      )}
      {user.totpEnabled && (
        <div className="stack">
          <Alert kind="ok">2FA is on.</Alert>
          {user.totpRequired ? (
            <p className="muted">2FA is required by an admin and cannot be turned off.</p>
          ) : (
            <>
              <div>
                <label>Your password (to turn it off)</label>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
              <div>
                <label>Verification code</label>
                <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              <button
                className="danger"
                onClick={async () => {
                  try {
                    await api('POST', '/me/2fa/disable', { password: pw, code });
                    setPw('');
                    setCode('');
                    setMsg({ ok: true, text: '2FA turned off.' });
                    await refresh();
                  } catch (x) {
                    fail(x);
                  }
                }}
              >
                Turn off 2FA
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- settings (admin): system name + logos ---------- */
function LogoSlot({ variant, title, hint, has, otherHas }: { variant: 'dark' | 'light'; title: string; hint: string; has: boolean; otherHas: boolean }) {
  const { version, set } = useBranding();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      set(await apiForm<Branding>(`/settings/logo/${variant}`, fd));
      setMsg({ ok: true, text: 'Logo updated.' });
    } catch (x) {
      setMsg({ ok: false, text: errorMessage(x) });
    }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try {
      set(await api<Branding>('DELETE', `/settings/logo/${variant}`));
      setMsg({ ok: true, text: 'Logo removed.' });
    } catch (x) {
      setMsg({ ok: false, text: errorMessage(x) });
    }
    setBusy(false);
  }

  return (
    <div className="card stack">
      <h2>{title}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {hint}
      </p>
      <div className={`logo-preview ${variant}`}>
        <img src={`/brand/logo/${variant}?v=${version}`} alt={`${title} preview`} />
      </div>
      {!has && <p className="muted">{otherHas ? 'No logo uploaded for this theme; the other logo is used here.' : 'No logo uploaded; a neutral placeholder icon is shown.'}</p>}
      {msg && <Alert kind={msg.ok ? 'ok' : 'bad'}>{msg.text}</Alert>}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {has ? 'Replace logo' : 'Upload logo'}
        </button>
        {has && (
          <button className="danger" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function Settings() {
  const b = useBranding();
  const [name, setName] = useState(b.siteName);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      b.set(await api<Branding>('PATCH', '/settings', { siteName: name }));
      setMsg({ ok: true, text: 'System name saved.' });
    } catch (x) {
      setMsg({ ok: false, text: errorMessage(x) });
    }
  }
  return (
    <>
      <h1>Settings</h1>
      <form className="card stack" onSubmit={save}>
        <h2>System name</h2>
        <p className="muted" style={{ margin: 0 }}>
          Shown in the panel header, the sign-in page, browser tab titles and on every shared document.
        </p>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        {msg && <Alert kind={msg.ok ? 'ok' : 'bad'}>{msg.text}</Alert>}
        <button className="primary">Save</button>
      </form>
      <LogoSlot
        variant="dark"
        title="Logo for the dark theme"
        hint="Shown on dark backgrounds, so use a light-colored logo. PNG, JPEG, WebP, GIF or SVG; ideally a transparent PNG or SVG, about 4:1 or square."
        has={b.hasLogoDark}
        otherHas={b.hasLogoLight}
      />
      <LogoSlot
        variant="light"
        title="Logo for the light theme"
        hint="Shown on light backgrounds, so use a dark-colored logo. If you only upload one logo it is used for both themes."
        has={b.hasLogoLight}
        otherHas={b.hasLogoDark}
      />
    </>
  );
}
