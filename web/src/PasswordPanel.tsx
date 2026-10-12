import React, { useState } from 'react';
import { api } from './api';

export default function PasswordPanel() {
  const [oldPassword,setOldPassword] = useState('');
  const [password,setPassword] = useState('');
  const [show,setShow] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  async function submit(event:React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/change-password',{method:'POST',body:JSON.stringify({oldPassword,password})});
      setOldPassword(''); setPassword(''); setNotice('Contraseña actualizada. No tendrá que volver a cambiarla.');
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="card password-card"><h2>Mi contraseña</h2><p>Cambiarla es opcional. La nueva contraseña debe tener al menos 8 caracteres.</p>
    {error && <div className="alert">{error}</div>}{notice && <div className="notice">{notice}</div>}
    <form onSubmit={submit}><label>Contraseña actual<input type={show?'text':'password'} value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" required/></label><label>Nueva contraseña<input type={show?'text':'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required/></label><label className="show-choice"><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)}/> Mostrar contraseñas</label><button className="primary" disabled={busy} type="submit">{busy?'Guardando…':'Guardar contraseña'}</button></form>
  </div>;
}
