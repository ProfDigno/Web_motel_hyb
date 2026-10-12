import React, { useState } from 'react';
import { api, type AuthResult } from './api';
import { APP_VERSION } from './version';

export default function AuthPanel({ onLogin }: { onLogin: (result: AuthResult) => void }) {
  const [username,setUsername] = useState('');
  const [password,setPassword] = useState('');
  const [showPassword,setShowPassword] = useState(false);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api<AuthResult>('/api/login',{method:'POST',body:JSON.stringify({username,password})});
      setPassword('');
      onLogin(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="login-shell"><div className="login-art"><div className="brand-mark">M</div><div><span className="eyebrow">GESTIÓN Y ANÁLISIS</span><h1>Información clara<br/>para cada turno.</h1><p>Informes de caja y usuarios exclusivos para la web.</p></div><div className="art-footer">MOTEL · PANEL DE INFORMES · v{APP_VERSION}</div></div><div className="login-pane"><form className="login-card" onSubmit={submit}>
    <span className="eyebrow dark">ACCESO</span>
    <h2>Bienvenido</h2>
    <p>Ingresá con tu cuenta web.</p>
    <label>Usuario<input type="text" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" maxLength={80} required/></label>
    <label>Contraseña<div className="password"><input type={showPassword?'text':'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" minLength={8} required/><button type="button" onClick={() => setShowPassword(!showPassword)}>{showPassword?'Ocultar':'Mostrar'}</button></div></label>
    {error && <div className="alert">{error}</div>}
    <button className="primary full" disabled={busy} type="submit">{busy?'Ingresando…':'Ingresar →'}</button>
  </form></div></div>;
}
