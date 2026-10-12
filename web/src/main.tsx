import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './simple-auth.css';
import './mobile.css';
import CashDetail, { type CashDetailData } from './CashDetail';
import AuthPanel from './AuthPanel';
import AdminUsers from './AdminUsers';
import PasswordPanel from './PasswordPanel';
import Occupancy from './Occupancy';
import { api, type AuthResult } from './api';

const Dashboard = React.lazy(() => import('./Dashboard'));

type Cashier = { id: number; nombre: string };
type Cash = { id: number; fecha_inicio: string; fecha_fin: string; estado: string; usuario: string; movimientos: number; ingreso: string; egreso: string; saldo: string };
const money = (v: string | number | null | undefined) => new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 }).format(Number(v || 0));
const date = (v: string | null | undefined) => v ? new Intl.DateTimeFormat('es-PY', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(v)) : '—';

function App() {
  const [auth,setAuth] = useState<AuthResult | null>(null);
  const [checking,setChecking] = useState(true);
  const [screen,setScreen] = useState<'dashboard'|'occupancy'|'cash'|'web-users'|'password'>('dashboard');
  const [error,setError] = useState('');
  const [cashiers,setCashiers] = useState<Cashier[]>([]);
  const [cash,setCash] = useState<Cash[]>([]);
  const [total,setTotal] = useState(0);
  const [page,setPage] = useState(1);
  const [filters,setFilters] = useState({from:'',to:'',user:'',state:'',turn:''});
  const [selected,setSelected] = useState<CashDetailData | null>(null);
  const [sync,setSync] = useState<{finished_at:string;report_count:number}|null>(null);
  const [loading,setLoading] = useState(false);
  const me = auth?.user || null;

  useEffect(() => { api<AuthResult>('/api/me').then(setAuth).catch(()=>{}).finally(()=>setChecking(false)); },[]);
  useEffect(() => { const onRequired = () => {setAuth(null);setSelected(null);}; window.addEventListener('auth-required',onRequired); return () => window.removeEventListener('auth-required',onRequired); },[]);
  useEffect(() => { if (!me) return; api<{sync:typeof sync}>('/api/status').then(x=>setSync(x.sync)).catch(()=>{}); api<{rows:Cashier[]}>('/api/cashier-users').then(x=>setCashiers(x.rows)).catch(()=>{}); },[me?.id]);
  useEffect(() => {
    if (!me || screen !== 'cash') return;
    setLoading(true); setError('');
    api<{rows:Cash[];total:number}>(`/api/cash?${new URLSearchParams({...filters,page:String(page)})}`)
      .then(x=>{setCash(x.rows);setTotal(x.total);}).catch(e=>setError(e.message)).finally(()=>setLoading(false));
  },[me?.id,screen,filters,page]);

  async function logout() { await api('/api/logout',{method:'POST'}).catch(()=>{}); setAuth(null); setSelected(null); setScreen('dashboard'); }
  async function openCash(id:number) { setLoading(true); setError(''); try { setSelected(await api<CashDetailData>(`/api/cash/${id}`)); } catch(e) { setError((e as Error).message); } finally { setLoading(false); } }
  const csvUrl = `/api/cash.csv?${new URLSearchParams(filters)}`;

  if (checking) return <div className="center">Cargando…</div>;
  if (!me) return <AuthPanel onLogin={setAuth}/>;
  return <div className="shell"><aside className="sidebar"><div className="logo"><span className="brand-mark small">M</span><span>Motel<small>Panel de informes</small></span></div><div className="nav-label">MENÚ PRINCIPAL</div><nav><button className={screen==='dashboard'?'active':''} onClick={()=>{setScreen('dashboard');setSelected(null);}}>▥ <span>Dashboard</span></button><button className={screen==='occupancy'?'active':''} onClick={()=>{setScreen('occupancy');setSelected(null);}}>▦ <span>Ocupación</span></button><button className={screen==='cash'?'active':''} onClick={()=>{setScreen('cash');setSelected(null);}}>▤ <span>Informes de caja</span></button>{me.role==='admin' && <button className={screen==='web-users'?'active':''} onClick={()=>{setScreen('web-users');setSelected(null);}}>♙ <span>Usuarios web</span></button>}<button className={screen==='password'?'active':''} onClick={()=>{setScreen('password');setSelected(null);}}>⚿ <span>Mi contraseña</span></button></nav><div className="sidebar-bottom"><div className="avatar">{me.username.slice(0,1).toUpperCase()}</div><div className="account"><strong>{me.username}</strong><small>{me.role==='admin'?'Administrador':'Consulta'}</small></div><button className="logout" onClick={logout} title="Salir">↗</button></div></aside><main className="content"><header className="topbar"><div><span className="eyebrow dark">PANEL DE CONTROL</span><h1>{selected?`Caja #${selected.header.id}`:screen==='dashboard'?'Dashboard':screen==='occupancy'?'Ocupación':screen==='cash'?'Informes de caja':screen==='web-users'?'Usuarios web':'Mi contraseña'}</h1></div>{screen!=='occupancy' && <div className="sync">● {sync?`Actualizado ${date(sync.finished_at)}`:'Esperando sincronización'}</div>}</header>{error && <div className="alert">{error}</div>}{loading && <div className="loading">Actualizando datos…</div>}
  {screen === 'dashboard' && <React.Suspense fallback={<div className="loading">Cargando gráficos…</div>}><Dashboard/></React.Suspense>}
  {screen === 'occupancy' && <Occupancy/>}
  {screen === 'cash' && !selected && <><div className="intro"><div><h2>Resumen de cierres</h2><p>Consulta los movimientos y resultados registrados en cada caja.</p></div><a className="outline" href={csvUrl}>↓ Exportar CSV</a></div><div className="filters"><label>Desde<input type="date" value={filters.from} onChange={e => { setPage(1); setFilters({ ...filters, from: e.target.value }); }}/></label><label>Hasta<input type="date" value={filters.to} onChange={e => { setPage(1); setFilters({ ...filters, to: e.target.value }); }}/></label><label>Usuario<select value={filters.user} onChange={e => { setPage(1); setFilters({ ...filters, user: e.target.value }); }}><option value="">Todos</option>{cashiers.map(u => <option key={u.id} value={u.id}>{u.nombre}</option>)}</select></label><label>Estado<select value={filters.state} onChange={e => { setPage(1); setFilters({ ...filters, state: e.target.value }); }}><option value="">Todos</option><option value="CERRADO">Cerrado</option><option value="ABIERTO">Abierto</option></select></label><label>Turno<select value={filters.turn} onChange={e => { setPage(1); setFilters({ ...filters, turn: e.target.value }); }}><option value="">Todos</option><option value="manana">Mañana</option><option value="tarde">Tarde</option><option value="noche">Noche</option><option value="otro">Otro</option></select></label></div><div className="card"><div className="card-head"><strong>Cierres registrados</strong><span>{total} resultados</span></div><div className="table-wrap"><table><thead><tr><th>N° caja</th><th>Inicio</th><th>Fin</th><th>Usuario</th><th>Estado</th><th>Ingreso</th><th>Egreso</th><th>Saldo</th><th></th></tr></thead><tbody>{cash.map(c => <tr key={c.id}><td className="strong">#{c.id}</td><td>{date(c.fecha_inicio)}</td><td>{date(c.fecha_fin)}</td><td>{c.usuario || '—'}</td><td><span className="badge">{c.estado}</span></td><td className="money">{money(c.ingreso)}</td><td className="money">{money(c.egreso)}</td><td className="money strong">{money(c.saldo)}</td><td><button className="link" onClick={() => openCash(c.id)}>Ver detalle →</button></td></tr>)}</tbody></table>{!cash.length && <div className="empty">No hay cierres para estos filtros.</div>}</div><div className="pagination"><span>Página {page} · {total} cierres</span><div><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><button disabled={page * 30 >= total} onClick={() => setPage(page + 1)}>Siguiente</button></div></div></div></>}
  {screen === 'cash' && selected && <CashDetail data={selected} onBack={() => setSelected(null)}/>}
  {screen==='web-users' && me.role==='admin' && <AdminUsers currentId={me.id}/>}
  {screen==='password' && <PasswordPanel/>}
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
