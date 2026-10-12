import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import './occupancy.css';

type Room = {
  id:number; reception_id:number; room_number:number; room_type:string; state:string; state_description:string;
  room_description:string; elapsed_label:string; elapsed_seconds:number; amount:string; background_color:string;
  text_color:string; entry_at:string|null; is_hour:boolean; is_sleep:boolean; is_lodging:boolean; advance:string;
  extra_hours:number; client_door:boolean; cleaning_door:boolean; is_manual:boolean; minimum_amount:string;
  additional_unit_amount:string; consumption_amount:string; sort_order:number; source_at:string;
};
type OccupancyResponse = { syncedAt:string|null; stale:boolean; rows:Room[] };
type OccupancyDetails = {
  observations:{ venta_id:number; fecha_creado:string; observacion:string }[];
  items:{ idventa_item:number; venta_id:number; fecha_creado:string; descripcion:string; cantidad:string|number; precio_venta:string|number; subtotal:string|number }[];
};

const money = (value: string | number) => new Intl.NumberFormat('es-PY',{maximumFractionDigits:0}).format(Number(value || 0));
const date = (value:string|null) => value ? new Intl.DateTimeFormat('es-PY',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)) : '—';
const safeColor = (value:string,fallback:string) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const mode = (room:Room) => room.is_lodging ? 'Hospedaje' : room.is_sleep && room.is_hour ? 'Hora + dormir' : room.is_sleep ? 'Dormir' : room.is_hour ? 'Por hora' : 'Sin modalidad';
const icon = (room:Room) => room.state === 'LIBRE' ? '○' : room.state === 'OCUPADO' ? room.is_sleep ? '☾' : room.is_lodging ? '▣' : '◷' : room.state === 'SUCIO' ? '◆' : room.state === 'LIMPIANDO' ? '✦' : '!';
function duration(seconds:number) {
  const value = Math.max(0,Math.floor(seconds));
  const days = Math.floor(value/86400), hours = Math.floor(value%86400/3600), minutes = Math.floor(value%3600/60), secs = value%60;
  return `${days ? String(days).padStart(2,'0')+' ' : ''}${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}

export default function Occupancy() {
  const [data,setData] = useState<OccupancyResponse>({syncedAt:null,stale:true,rows:[]});
  const [selected,setSelected] = useState<Room|null>(null);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const [tab,setTab] = useState<'info'|'observation'|'consumption'>('info');
  const [details,setDetails] = useState<OccupancyDetails|null>(null);
  const [detailsLoading,setDetailsLoading] = useState(false);
  const [detailsError,setDetailsError] = useState('');
  const [clock,setClock] = useState(Date.now());
  const load = useCallback(async (manual=false) => {
    if (manual) setLoading(true);
    setError('');
    try {
      const next = await api<OccupancyResponse>('/api/occupancy');
      setData(next);
      setSelected(current => current ? next.rows.find(room => room.id===current.id) || null : null);
    } catch(e) { setError((e as Error).message); }
    finally { setLoading(false); }
  },[]);
  useEffect(() => { load(); const refresh=window.setInterval(()=>load(),60000); const timer=window.setInterval(()=>setClock(Date.now()),1000); return ()=>{clearInterval(refresh);clearInterval(timer);}; },[load]);
  useEffect(() => {
    setTab('info');
    setDetails(null);
    setDetailsError('');
    if (!selected || selected.state !== 'OCUPADO') return;
    let cancelled = false;
    setDetailsLoading(true);
    api<OccupancyDetails>(`/api/occupancy/${selected.reception_id}/details`)
      .then(next => { if (!cancelled) setDetails(next); })
      .catch(error => { if (!cancelled) setDetailsError((error as Error).message); })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  },[selected?.reception_id,selected?.state]);
  const extraSeconds = data.syncedAt ? Math.max(0,Math.floor((clock-new Date(data.syncedAt).getTime())/1000)) : 0;
  const stale = !data.syncedAt || clock-new Date(data.syncedAt).getTime()>120000;
  const counts = useMemo(() => data.rows.reduce<Record<string,number>>((all,room)=>{all[room.state]=(all[room.state]||0)+1;return all;},{}),[data.rows]);
  const elapsed = (room:Room) => {
    if (room.state==='LIBRE') return '—';
    if (['OCUPADO','SUCIO','LIMPIANDO'].includes(room.state)) return duration(Number(room.elapsed_seconds||0)+extraSeconds);
    return room.elapsed_label || '—';
  };
  const additional = (room:Room) => room.is_lodging
    ? 'No aplica'
    : `${room.extra_hours} × ${money(room.additional_unit_amount)} = ${money(room.extra_hours * Number(room.additional_unit_amount || 0))}`;

  return <div className="occupancy">
    <div className="occupancy-toolbar"><div><h2>Estado de habitaciones</h2><p>Consulta actualizada desde la recepción del motel.</p></div><button className="outline" onClick={()=>load(true)} disabled={loading}>{loading?'Actualizando…':'↻ Actualizar'}</button></div>
    {stale && <div className="alert occupancy-stale">Los estados tienen más de dos minutos de atraso. Se muestra la última información válida.</div>}
    {error && <div className="alert">{error}</div>}
    <div className="occupancy-summary"><div><span>Total</span><strong>{data.rows.length}</strong></div>{Object.entries(counts).sort().map(([state,count])=><div key={state}><span>{state}</span><strong>{count}</strong></div>)}</div>
    <div className="occupancy-meta">Última actualización: <strong>{date(data.syncedAt)}</strong></div>
    {data.rows.length ? <div className="room-grid">{data.rows.map(room => <button key={room.id} className="room-card" style={{background:safeColor(room.background_color,'#f0f0f0'),color:safeColor(room.text_color,'#000000')}} onClick={()=>setSelected(room)}>
      <span className="room-card-top"><span className="room-icon">{icon(room)}</span><span className="room-number">Habitación {room.room_number}</span></span>
      <span className="room-type">{room.room_type}</span><strong className="room-state">{room.state_description || room.state}</strong>
      <span className="room-time">{elapsed(room)}</span><span className="room-amount">{Number(room.amount)>0 ? money(room.amount) : '—'}</span>
    </button>)}</div> : <div className="card detail-empty">Todavía no hay una sincronización de habitaciones.</div>}
    {selected && <div className="room-modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected(null);}}><section className="room-modal" role="dialog" aria-modal="true" aria-labelledby="room-title">
      <button className="room-close" onClick={()=>setSelected(null)} aria-label="Cerrar">×</button>
      <span className="eyebrow dark">DETALLE DE OCUPACIÓN</span><h2 id="room-title">Habitación {selected.room_number}</h2><span className="badge">{selected.state}</span>
      <div className="room-tabs" role="tablist" aria-label="Detalle de habitación">
        <button role="tab" aria-selected={tab==='info'} className={tab==='info'?'active':''} onClick={()=>setTab('info')}>Información</button>
        <button role="tab" aria-selected={tab==='observation'} disabled={selected.state!=='OCUPADO'} className={tab==='observation'?'active':''} onClick={()=>setTab('observation')}>Observación</button>
        <button role="tab" aria-selected={tab==='consumption'} disabled={selected.state!=='OCUPADO'} className={tab==='consumption'?'active':''} onClick={()=>setTab('consumption')}>Consumo</button>
      </div>
      {tab==='info' && <dl><dt>Tipo</dt><dd>{selected.room_type||'—'}</dd><dt>Modalidad</dt><dd>{mode(selected)}</dd><dt>Ingreso</dt><dd>{date(selected.entry_at)}</dd><dt>Tiempo</dt><dd>{elapsed(selected)}</dd><dt>Control</dt><dd>{selected.is_manual?'Manual':'Automático'}</dd><dt>Adelanto</dt><dd className="room-money">{money(selected.advance)}</dd><dt>Monto mínimo</dt><dd className="room-money">{money(selected.minimum_amount)}</dd><dt>Consumo</dt><dd className="room-money">{money(selected.consumption_amount)}</dd><dt>Horas adicionales</dt><dd className="room-money">{additional(selected)}</dd><dt>Monto acumulado</dt><dd className="room-money room-total">{money(selected.amount)}</dd></dl>}
      {tab!=='info' && <div className="room-tab-content">
        {detailsLoading && <div className="detail-empty">Cargando información…</div>}
        {!detailsLoading && detailsError && <div className="alert">{detailsError}</div>}
        {!detailsLoading && !detailsError && tab==='observation' && (details?.observations.length ? details.observations.map(row => <article className="sale-observation" key={row.venta_id}><strong>Venta #{row.venta_id}</strong><small>{date(row.fecha_creado)}</small><p>{row.observacion}</p></article>) : <div className="detail-empty">Sin observación registrada.</div>)}
        {!detailsLoading && !detailsError && tab==='consumption' && (details?.items.length ? <div className="room-consumption-table"><table><thead><tr><th>Venta</th><th>Descripción</th><th>Cantidad</th><th>Precio</th><th>Subtotal</th></tr></thead><tbody>{details.items.map(item => <tr key={item.idventa_item}><td>#{item.venta_id}</td><td>{item.descripcion||'—'}</td><td>{item.cantidad}</td><td className="room-money">{money(item.precio_venta)}</td><td className="room-money">{money(item.subtotal)}</td></tr>)}</tbody></table></div> : <div className="detail-empty">Sin consumos registrados.</div>)}
      </div>}
    </section></div>}
  </div>;
}
