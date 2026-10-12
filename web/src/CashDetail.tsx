import React from 'react';
import './cash-detail.css';

type Money = string | number;
type Header = { id: number; fecha_inicio: string; fecha_fin: string | null; estado: string; usuario: string | null; creado_por: string | null };
type Summary = Record<'minimo' | 'adicional' | 'consumo' | 'descuento' | 'adelanto' | 'interno' | 'garantia' | 'ingreso' | 'efectivo' | 'tarjeta' | 'transferencia' | 'compra' | 'vale' | 'liquidacion' | 'gasto' | 'egreso' | 'saldo' | 'apertura', Money> & { ocupaciones: number };
type Movement = { id: number; fecha_creado: string; descripcion: string | null; estado: string; forma_pago: string | null; venta_id: number; gasto_id: number; compra_id: number; es_cerrado: boolean; es_caja: boolean; [key: string]: unknown };
type Occupancy = { id: number; fecha_creado: string; descripcion: string; habitacion: Money; consumo: Money; total: Money };
type Product = { descripcion: string; cantidad: Money; subtotal: Money };
type Expense = { id: number; fecha_creado: string; tipo: string; descripcion: string; monto: Money };
type Guarantee = { id: number; responsable: string; descripcion_objeto: string; estado: string; monto: Money };
type Cancelled = { id: number; descripcion: string };
export type CashDetailData = { header: Header; summary: Summary; rows: Movement[]; sections: { occupancies: Occupancy[]; consumption: Product[]; internalSales: Product[]; expenses: Expense[]; guarantees: Guarantee[]; cancelled: Cancelled[] } };

const amount = (value: unknown) => Number(value ?? 0);
const money = (value: unknown) => new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 }).format(amount(value));
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('es-PY', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(value)) : '—';
const hour = (value: string) => new Intl.DateTimeFormat('es-PY', { hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(value));

function Lines({ title, rows, total }: { title: string; rows: [string, Money][]; total?: [string, Money] }) {
  return <section className="card detail-block"><div className="card-head"><strong>{title}</strong></div><dl className="detail-lines">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{money(value)}</dd></React.Fragment>)}{total && <><dt className="detail-total">{total[0]}</dt><dd className="detail-total">{money(total[1])}</dd></>}</dl></section>;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="card detail-section"><div className="card-head"><strong>{title}</strong><span>{count} registros</span></div>{count ? <div className="table-wrap">{children}</div> : <div className="detail-empty">Sin registros en este cierre.</div>}</section>;
}

export default function CashDetail({ data, onBack }: { data: CashDetailData; onBack: () => void }) {
  const { header, summary: s, sections, rows } = data;
  const difference = amount(s.efectivo) + amount(s.tarjeta) + amount(s.transferencia) - amount(s.ingreso);
  return <div className="cash-detail">
    <div className="detail-actions"><button className="outline" onClick={onBack}>← Volver</button><button className="outline" onClick={() => window.print()}>▤ Imprimir</button></div>
    <section className="card detail-heading"><div><span className="eyebrow dark">CIERRE DE CAJA</span><h2>Caja #{header.id}</h2><span className="badge">{header.estado}</span></div><dl><dt>Usuario</dt><dd>{header.creado_por || header.usuario || '—'}</dd><dt>Inicio</dt><dd>{date(header.fecha_inicio)}</dd><dt>Fin</dt><dd>{date(header.fecha_fin)}</dd><dt>Ocupaciones</dt><dd>{s.ocupaciones}</dd></dl></section>
    <div className="metrics detail-metrics"><div><span>Ingreso</span><strong>{money(s.ingreso)}</strong></div><div><span>Egreso</span><strong>{money(s.egreso)}</strong></div><div><span>Saldo</span><strong>{money(s.saldo)}</strong></div><div><span>Apertura de caja</span><strong>{money(s.apertura)}</strong></div></div>
    <div className="detail-grid">
      <Lines title="Datos de ingreso" rows={[["Mínimo (neto de adelanto aplicado)",s.minimo],["Adicional",s.adicional],["Consumo",s.consumo],["Descuento",-amount(s.descuento)],["Adelantos cobrados",s.adelanto],["Venta interna",s.interno],["Garantía",s.garantia]]} total={["Total ingreso",s.ingreso]}/>
      <Lines title="Formas de pago" rows={[["Efectivo",s.efectivo],["Tarjeta",s.tarjeta],["Transferencia",s.transferencia]]} total={["Total pagos",amount(s.efectivo)+amount(s.tarjeta)+amount(s.transferencia)]}/>
      <Lines title="Datos de egreso" rows={[["Compra",s.compra],["Vale",s.vale],["Liquidación",s.liquidacion],["Gasto",s.gasto]]} total={["Total egreso",s.egreso]}/>
    </div>
    {difference !== 0 && <div className="alert detail-warning">Diferencia entre formas de pago e ingreso: {money(difference)}. Se muestran los importes registrados, sin ajustes automáticos.</div>}
    <Section title="Ocupaciones y adelantos" count={sections.occupancies.length}><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Habitación</th><th>Consumo</th><th>Total</th></tr></thead><tbody>{sections.occupancies.map(r => <tr key={r.id}><td>{date(r.fecha_creado)}</td><td>{r.descripcion}</td><td className="money">{money(r.habitacion)}</td><td className="money">{money(r.consumo)}</td><td className="money strong">{money(r.total)}</td></tr>)}</tbody></table></Section>
    <div className="detail-grid two">
      <Section title="Productos consumidos" count={sections.consumption.length}><table><thead><tr><th>Producto</th><th>Cantidad</th><th>Subtotal</th></tr></thead><tbody>{sections.consumption.map((r,i) => <tr key={i}><td>{r.descripcion}</td><td>{r.cantidad}</td><td className="money">{money(r.subtotal)}</td></tr>)}</tbody></table></Section>
      <Section title="Ventas internas" count={sections.internalSales.length}><table><thead><tr><th>Producto</th><th>Cantidad</th><th>Subtotal</th></tr></thead><tbody>{sections.internalSales.map((r,i) => <tr key={i}><td>{r.descripcion}</td><td>{r.cantidad}</td><td className="money">{money(r.subtotal)}</td></tr>)}</tbody></table></Section>
    </div>
    <div className="detail-grid two">
      <Section title="Gastos de caja" count={sections.expenses.length}><table><thead><tr><th>Hora</th><th>Tipo / descripción</th><th>Total</th></tr></thead><tbody>{sections.expenses.map(r => <tr key={r.id}><td>{hour(r.fecha_creado)}</td><td>{r.tipo} — {r.descripcion}</td><td className="money">{money(r.monto)}</td></tr>)}</tbody></table></Section>
      <Section title="Garantías" count={sections.guarantees.length}><table><thead><tr><th>Responsable / objeto</th><th>Estado</th><th>Total</th></tr></thead><tbody>{sections.guarantees.map(r => <tr key={r.id}><td>{r.responsable} — {r.descripcion_objeto}</td><td>{r.estado}</td><td className="money">{money(r.monto)}</td></tr>)}</tbody></table></Section>
    </div>
    <Section title="Ocupaciones canceladas" count={sections.cancelled.length}><table><thead><tr><th>ID</th><th>Descripción</th></tr></thead><tbody>{sections.cancelled.map(r => <tr key={r.id}><td>#{r.id}</td><td>{r.descripcion}</td></tr>)}</tbody></table></Section>
    <Section title="Todos los movimientos" count={rows.length}><table><thead><tr><th>ID</th><th>Fecha</th><th>Descripción</th><th>Referencia</th><th>Forma de pago</th><th>Ingreso</th><th>Egreso</th></tr></thead><tbody>{rows.map(r => { const included = header.estado === 'CERRADO' ? r.es_caja : r.es_cerrado; const ingreso = included ? amount(r.monto_solo_adelanto)+amount(r.monto_ocupa_minimo)+amount(r.monto_ocupa_adicional)+amount(r.monto_ocupa_consumo)+amount(r.monto_interno)+amount(r.monto_garantia)-amount(r.monto_ocupa_descuento)-amount(r.monto_ocupa_adelanto) : 0; const egreso = included && r.es_caja ? amount(r.monto_gasto)+amount(r.monto_compra)+amount(r.monto_vale)+amount(r.monto_liquidacion) : 0; return <tr key={r.id}><td>#{r.id}</td><td>{date(r.fecha_creado)}</td><td>{r.descripcion || r.estado}</td><td>{r.venta_id>0 ? `Venta #${r.venta_id}` : r.gasto_id>0 ? `Gasto #${r.gasto_id}` : r.compra_id>0 ? `Compra #${r.compra_id}` : 'Movimiento'}</td><td>{r.forma_pago || '—'}</td><td className="money">{money(ingreso)}</td><td className="money">{money(egreso)}</td></tr>; })}</tbody></table></Section>
  </div>;
}
