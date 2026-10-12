import React, { useEffect, useState } from 'react';
import { api, type WebAccount } from './api';

type Row = WebAccount & { active: boolean; created_at: string };
export default function AdminUsers({ currentId }: {currentId:number}) {
  const [rows,setRows] = useState<Row[]>([]);
  const [username,setUsername] = useState('');
  const [password,setPassword] = useState('');
  const [role,setRole] = useState<'admin'|'consulta'>('consulta');
  const [resetRow,setResetRow] = useState<Row|null>(null);
  const [resetPassword,setResetPassword] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  async function refresh() { const result = await api<{rows:Row[]}>('/api/web-users'); setRows(result.rows); }
  useEffect(() => { refresh().catch(e => setError(e.message)); },[]);
  async function create(event:React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/web-users',{method:'POST',body:JSON.stringify({username,role,password})});
      setUsername(''); setPassword(''); setNotice('Usuario creado. Ya puede ingresar con esa contraseña.');
      await refresh();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function update(id:number,change:{active?:boolean;role?:'admin'|'consulta'}) {
    setBusy(true); setError(''); setNotice('');
    try { await api(`/api/web-users/${id}`,{method:'PATCH',body:JSON.stringify(change)}); await refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function savePassword(event:React.FormEvent) {
    event.preventDefault();
    if (!resetRow) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/web-users/${resetRow.id}/reset-password`,{method:'POST',body:JSON.stringify({password:resetPassword})});
      setNotice(`Contraseña actualizada para ${resetRow.username}.`);
      setResetRow(null); setResetPassword('');
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><div className="intro"><div><h2>Usuarios web</h2><p>Estas cuentas son independientes de los usuarios del sistema Java.</p></div></div>
    {error && <div className="alert">{error}</div>}{notice && <div className="notice">{notice}</div>}
    <form className="filters create-user" onSubmit={create}>
      <label>Nuevo usuario<input type="text" value={username} onChange={e => setUsername(e.target.value)} maxLength={80} required/></label>
      <label>Contraseña<input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required/><small>Mínimo 8 caracteres. No se exigirá cambiarla.</small></label>
      <label>Perfil<select value={role} onChange={e => setRole(e.target.value as 'admin'|'consulta')}><option value="consulta">Consulta</option><option value="admin">Administrador</option></select></label>
      <button className="primary" type="submit" disabled={busy}>Crear usuario</button>
    </form>
    <div className="card"><div className="card-head"><strong>Cuentas web</strong><span>{rows.length} usuarios</span></div><div className="table-wrap"><table><thead><tr><th>Usuario</th><th>Perfil</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td className="strong">{r.username}</td><td><select value={r.role} disabled={busy || r.id===currentId} onChange={e => update(r.id,{role:e.target.value as 'admin'|'consulta'})}><option value="consulta">Consulta</option><option value="admin">Administrador</option></select></td><td><span className={'badge '+(r.active?'ok':'off')}>{r.active?'Activo':'Inactivo'}</span></td><td><button className="link" disabled={busy || r.id===currentId} onClick={() => {setResetRow(r);setResetPassword('');}}>Cambiar contraseña</button><button className="link" disabled={busy || r.id===currentId} onClick={() => update(r.id,{active:!r.active})}>{r.active?'Desactivar':'Activar'}</button></td></tr>)}</tbody></table></div></div>
    {resetRow && <form className="filters reset-user" onSubmit={savePassword}><label>Nueva contraseña para {resetRow.username}<input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} minLength={8} autoComplete="new-password" required/><small>Mínimo 8 caracteres.</small></label><button className="primary" disabled={busy} type="submit">Guardar contraseña</button><button className="outline" type="button" onClick={() => {setResetRow(null);setResetPassword('');}}>Cancelar</button></form>}
  </>;
}
