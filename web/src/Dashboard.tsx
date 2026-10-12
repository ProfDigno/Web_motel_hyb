import React, { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from './api';
import './dashboard.css';

type Row = Record<string, string | number | null>;
type Data = { filters:{from:string;to:string}; generatedAt:string; totals:Row; daily:Row[]; payments:{methods:Row[];forms:Row[]}; rooms:Row[]; durations:Row; heatmap:Row[]; products:Row[]; productsByAmount:Row[]; categories:Row[]; states:Row[] };
type Item = { name:string; value:number; detail?:string };
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>new Intl.NumberFormat('es-PY',{maximumFractionDigits:0}).format(num(v));
const count=(v:unknown)=>new Intl.NumberFormat('es-PY',{maximumFractionDigits:1}).format(num(v));
const compact=(v:unknown)=>new Intl.NumberFormat('es-PY',{notation:'compact',maximumFractionDigits:1}).format(num(v));
const dateTime=(v:string)=>new Intl.DateTimeFormat('es-PY',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v));
const shortDate=(v:unknown)=>{const [y,m,d]=String(v||'').slice(0,10).split('-');return y&&m&&d?`${d}/${m}/${y.slice(-2)}`:String(v||'');};
const localDate=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const monthStart=()=>{const d=new Date();d.setDate(1);return localDate(d);};
const duration=(v:unknown)=>{const m=Math.max(0,Math.round(num(v)*60));return `${Math.floor(m/60)} h ${String(m%60).padStart(2,'0')} min`;};
const weekdays=['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const palette=['#176c55','#d8974b','#547ea8','#9a6c9b','#86a765','#c66d62','#688e8b'];
const tick={fill:'#78877d',fontSize:11};

function Card({title,note,children,wide=false}:{title:string;note?:string;children:React.ReactNode;wide?:boolean}){
  return <section className={`dash-card${wide?' dash-wide':''}`}><div className="dash-card-head"><h3>{title}</h3>{note&&<p>{note}</p>}</div>{children}</section>;
}
function Empty(){return <div className="dash-empty">Sin datos en este período</div>;}
function Rank({rows,unit='Gs.',max=10}:{rows:Item[];unit?:string;max?:number}){
  const items=rows.slice(0,max);
  if(!items.some(x=>x.value!==0))return <Empty/>;
  return <div className="dash-rank"><ResponsiveContainer width="100%" height={Math.max(200,items.length*38+20)}>
    <BarChart data={items} layout="vertical" margin={{top:4,right:12,bottom:4,left:0}} barCategoryGap="28%">
      <CartesianGrid horizontal={false} stroke="#e8eeea"/><XAxis type="number" tickFormatter={compact} tick={tick} axisLine={false} tickLine={false}/>
      <YAxis type="category" dataKey="name" width={112} tick={tick} axisLine={false} tickLine={false} tickFormatter={v=>String(v).length>17?String(v).slice(0,16)+'…':String(v)}/>
      <Tooltip cursor={{fill:'#f2f7f4'}} formatter={v=>[`${unit==='Gs.'?money(v):count(v)} ${unit}`,'Total']} contentStyle={{borderRadius:12,borderColor:'#dfe8e1',boxShadow:'0 10px 25px #193a2b1a'}}/>
      <Bar dataKey="value" fill="#176c55" radius={[0,5,5,0]} maxBarSize={18} isAnimationActive={false}/>
    </BarChart></ResponsiveContainer>
    <div className="dash-rank-details">{items.map(x=><div key={x.name}><span>{x.name}</span><strong>{unit==='Gs.'?money(x.value):count(x.value)} {unit}</strong>{x.detail&&<small>{x.detail}</small>}</div>)}</div>
  </div>;
}
function Donut({rows,unit='Gs.'}:{rows:Item[];unit?:string}){
  const items=rows.filter(x=>x.value>0),total=items.reduce((s,x)=>s+x.value,0);
  if(!items.length)return <Empty/>;
  return <div className="dash-donut-layout"><div className="dash-donut"><ResponsiveContainer width="100%" height={225}><PieChart>
    <Pie data={items} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={65} outerRadius={90} paddingAngle={2} stroke="none" isAnimationActive={false}>{items.map((x,i)=><Cell key={x.name} fill={palette[i%palette.length]}/>)}</Pie>
    <Tooltip formatter={v=>`${unit==='Gs.'?money(v):count(v)} ${unit}`} contentStyle={{borderRadius:12,borderColor:'#dfe8e1'}}/>
  </PieChart></ResponsiveContainer><div className="dash-donut-center"><strong>{unit==='Gs.'?compact(total):count(total)}</strong><span>{unit==='Gs.'?'Gs. total':unit}</span></div></div>
    <div className="dash-donut-legend">{items.map((x,i)=><div key={x.name}><i style={{backgroundColor:palette[i%palette.length]}}/><span>{x.name}</span><strong>{unit==='Gs.'?money(x.value):count(x.value)}</strong></div>)}</div></div>;
}
function Daily({rows,metric}:{rows:Row[];metric:'total'|'occupations'}){
  if(!rows.length)return <Empty/>;
  const sales=metric==='total',items=rows.map(x=>({name:shortDate(x.day),value:num(x[metric])}));
  return <div className="dash-chart-scroll"><div style={{minWidth:Math.max(0,items.length*26)}}><ResponsiveContainer width="100%" height={260}>
    {sales?<AreaChart data={items} margin={{top:14,right:16,left:-12,bottom:4}}><defs><linearGradient id="dash-sales-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#176c55" stopOpacity={0.22}/><stop offset="100%" stopColor="#176c55" stopOpacity={0.01}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#e8eeea"/><XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} minTickGap={24}/><YAxis tickFormatter={compact} tick={tick} axisLine={false} tickLine={false} width={52}/><Tooltip formatter={v=>[`${money(v)} Gs.`,'Vendido']} contentStyle={{borderRadius:12,borderColor:'#dfe8e1'}}/><Area type="monotone" dataKey="value" stroke="#176c55" strokeWidth={2.5} fill="url(#dash-sales-gradient)" activeDot={{r:5}} isAnimationActive={false}/></AreaChart>
      :<BarChart data={items} margin={{top:14,right:16,left:-12,bottom:4}}><CartesianGrid vertical={false} stroke="#e8eeea"/><XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} minTickGap={24}/><YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} width={52}/><Tooltip formatter={v=>[`${count(v)} ocupaciones`,'Cantidad']} cursor={{fill:'#f2f7f4'}} contentStyle={{borderRadius:12,borderColor:'#dfe8e1'}}/><Bar dataKey="value" fill="#d8974b" radius={[4,4,0,0]} maxBarSize={24} isAnimationActive={false}/></BarChart>}
  </ResponsiveContainer></div></div>;
}
function Heatmap({rows}:{rows:Row[]}){
  const [selected,setSelected]=useState<{day:number;hour:number}|null>(null);
  const values=useMemo(()=>new Map(rows.map(x=>[`${x.weekday}-${x.hour}`,num(x.count)])),[rows]);
  const max=Math.max(1,...values.values());
  return <><div className="dash-heat-scroll"><div className="dash-heat" role="grid" aria-label="Ocupaciones por día y hora"><div className="dash-heat-row dash-heat-hours"><span/>{Array.from({length:24},(_,h)=><span key={h}>{String(h).padStart(2,'0')}</span>)}</div>
    {weekdays.map((day,i)=><div className="dash-heat-row" key={day}><strong>{day.slice(0,3)}</strong>{Array.from({length:24},(_,h)=>{const value=values.get(`${i+1}-${h}`)||0,level=value?Math.max(1,Math.ceil(value/max*5)):0;return <button key={h} type="button" className={`dash-heat-cell level-${level}`} aria-label={`${day} ${String(h).padStart(2,'0')}:00, ${count(value)} ocupaciones`} aria-pressed={selected?.day===i+1&&selected.hour===h} onClick={()=>setSelected({day:i+1,hour:h})} title={`${day} ${String(h).padStart(2,'0')}:00 · ${count(value)} ocupaciones`}/>})}</div>)}
  </div></div><div className="dash-heat-bottom"><span>Menos</span>{[0,1,2,3,4,5].map(i=><i key={i} className={`level-${i}`}/>)}<span>Más</span><strong aria-live="polite">{selected?`${weekdays[selected.day-1]} ${String(selected.hour).padStart(2,'0')}:00 · ${count(values.get(`${selected.day}-${selected.hour}`)||0)} ocupaciones`:'Seleccione una celda para ver la cantidad'}</strong></div></>;
}
export default function Dashboard(){
  const [from,setFrom]=useState(monthStart()),[to,setTo]=useState(localDate()),[data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[productMetric,setProductMetric]=useState<'quantity'|'amount'>('quantity');
  const load=async()=>{setLoading(true);setError('');try{setData(await api<Data>(`/api/dashboard?${new URLSearchParams({from,to})}`));}catch(e){setError((e as Error).message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const totals=data?.totals||{},days=data?.daily.length||1;
  const weekdayRows=weekdays.map((name,i)=>({name,value:(data?.heatmap||[]).filter(x=>num(x.weekday)===i+1).reduce((s,x)=>s+num(x.count),0)}));
  const hourRows=Array.from({length:24},(_,h)=>({name:`${String(h).padStart(2,'0')}:00`,value:(data?.heatmap||[]).filter(x=>num(x.hour)===h).reduce((s,x)=>s+num(x.count),0)}));
  const products=(productMetric==='quantity'?data?.products:data?.productsByAmount)||[];
  return <div className="dashboard">
    <header className="dash-header"><div><span className="dash-eyebrow">ANÁLISIS DEL MOTEL</span><h2>Dashboard</h2><p>Ventas, ocupaciones y productos en una sola vista.</p></div><form className="dash-filters" onSubmit={e=>{e.preventDefault();void load();}}><label>Desde<input type="date" value={from} onChange={e=>setFrom(e.target.value)} required/></label><label>Hasta<input type="date" value={to} onChange={e=>setTo(e.target.value)} required/></label><button type="submit" disabled={loading}>{loading?'Consultando…':'Aplicar filtros'}</button></form></header>
    {error&&<div className="alert" role="alert">{error}</div>}
    {data&&<><div className="dash-meta"><span>Período <strong>{shortDate(data.filters.from)} — {shortDate(data.filters.to)}</strong></span><span>Actualizado {dateTime(data.generatedAt)} · copia horaria</span><button type="button" onClick={()=>void load()} disabled={loading}>Actualizar datos ↻</button></div>
      <div className="dash-kpis"><div className="dash-kpi"><span>Ventas válidas</span><strong>{count(totals.sales)}</strong><small>Sin canceladas ni anuladas</small></div><div className="dash-kpi"><span>Ocupaciones</span><strong>{count(totals.occupations)}</strong><small>{count(num(totals.occupations)/days)} por día en promedio</small></div><div className="dash-kpi featured"><span>Total vendido</span><strong>{money(totals.total)} <em>Gs.</em></strong><small>Descuentos incluidos</small></div><div className="dash-kpi"><span>Tiempo ocupado promedio</span><strong>{duration(data.durations.occupied)}</strong><small>Sucio {duration(data.durations.dirty)} · limpieza {duration(data.durations.cleaning)}</small></div></div>
      <div className="dash-grid"><Card title="Ventas por día" note="Guaraníes vendidos; toque o pase el cursor sobre el gráfico" wide><Daily rows={data.daily} metric="total"/></Card><Card title="Ocupaciones por día" note="Cantidad de ingresos a habitación" wide><Daily rows={data.daily} metric="occupations"/></Card>
        <Card title="Formas de pago" note="Importes registrados en caja"><Donut rows={data.payments.methods.map(x=>({name:String(x.method),value:num(x.amount)}))}/></Card><Card title="Habitaciones más usadas" note="Cantidad de ocupaciones por habitación"><Rank rows={data.rooms.map(x=>({name:`Hab. ${x.room}`,value:num(x.occupations),detail:`${money(x.amount)} Gs. · ${count(num(totals.occupations)?num(x.occupations)/num(totals.occupations)*100:0)} % del total`}))} unit="ocup."/></Card>
        <Card title="Montos por concepto" note="Adelantos y descuentos por separado"><Rank max={5} rows={[{name:'Mínimo',value:num(totals.minimo)},{name:'Adicionales',value:num(totals.adicional)},{name:'Consumos',value:num(totals.consumo)},{name:'Adelantos',value:num(totals.adelanto)},{name:'Descuentos',value:num(totals.descuento)}]}/></Card><Card title="Estados de venta" note="Incluye canceladas y otros estados"><Donut rows={data.states.map(x=>({name:String(x.state),value:num(x.count)}))} unit="ventas"/></Card>
        <Card title="Productos más vendidos" note="Seleccione cómo ordenar el ranking" wide><div className="dash-tabs" role="group" aria-label="Ordenar productos"><button type="button" aria-pressed={productMetric==='quantity'} onClick={()=>setProductMetric('quantity')}>Por cantidad</button><button type="button" aria-pressed={productMetric==='amount'} onClick={()=>setProductMetric('amount')}>Por monto</button></div><Rank rows={products.map(x=>({name:String(x.product),value:num(x[productMetric]),detail:`${x.category||'Sin categoría'} · ${productMetric==='quantity'?`${money(x.amount)} Gs.`:`${count(x.quantity)} unidades`}`}))} unit={productMetric==='quantity'?'unid.':'Gs.'} max={12}/></Card>
        <Card title="Categorías de productos" note="Importe vendido por categoría"><Rank rows={data.categories.map(x=>({name:String(x.category),value:num(x.amount),detail:`${count(x.quantity)} unidades`}))}/></Card><Card title="Días con más ocupaciones" note="Acumulado por día de semana"><Rank rows={[...weekdayRows].sort((a,b)=>b.value-a.value)} unit="ocup." max={7}/></Card>
        <Card title="Horas de mayor ocupación" note="Las 10 franjas con más ingresos"><Rank rows={[...hourRows].sort((a,b)=>b.value-a.value)} unit="ocup."/></Card><Card title="Formas registradas" note="Cantidad de movimientos por forma de pago"><Rank rows={data.payments.forms.map(x=>({name:String(x.forma_pago),value:num(x.count),detail:`${money(x.amount)} Gs.`}))} unit="mov."/></Card>
        <Card title="Mapa de ocupación" note="Día de semana × hora de ingreso" wide><Heatmap rows={data.heatmap}/></Card>
      </div></>}
  </div>;
}
