"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const TZ  = "America/Mexico_City";

// ─── Date utilities ───────────────────────────────────────────────────────────
const fromDB = (ts: string) => /Z|[+-]\d{2}:\d{2}$/.test(ts) ? ts : ts + "Z";

const fmtDate = (iso: string, opts?: Intl.DateTimeFormatOptions) =>
  new Date(fromDB(iso)).toLocaleDateString("es-MX", { timeZone: TZ, ...opts });

const fmtDateOnly = (dateStr: string) => {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtDateTime = (iso: string) =>
  new Date(fromDB(iso)).toLocaleString("es-MX", {
    timeZone: TZ, weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

const localToISO = (dt: string) => dt ? new Date(dt + ":00.000-06:00").toISOString() : "";

const isoToLocal = (iso: string) => {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(fromDB(iso)));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const h = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${h}:${get("minute")}`;
};

const timeAgo = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(fromDB(iso)).getTime()) / 60000);
  if (m < 1)  return "Ahora";
  if (m < 60) return `Hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  return `Hace ${Math.floor(h / 24)}d`;
};

const timeUntil = (iso: string) => {
  const diff = new Date(fromDB(iso)).getTime() - Date.now();
  if (diff <= 0) {
    const m = Math.floor(-diff / 60000);
    if (m < 60) return `Venció hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Venció hace ${h}h`;
    return `Venció hace ${Math.floor(h / 24)}d`;
  }
  const m = Math.floor(diff / 60000);
  if (m < 60) return `En ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `En ${h}h`;
  return `En ${Math.floor(h / 24)}d`;
};

// ─── Días hábiles (SAT/AGA — Ley Federal del Trabajo + Código Fiscal) ─────────
// Festivos oficiales México 2025-2027 (días que la aduana NO trabaja)
const FESTIVOS: Record<string, true> = {
  "2025-01-01":true,"2025-02-03":true,"2025-03-17":true,"2025-04-17":true,
  "2025-04-18":true,"2025-05-01":true,"2025-09-16":true,"2025-11-17":true,"2025-12-25":true,
  "2026-01-01":true,"2026-02-02":true,"2026-03-16":true,"2026-04-02":true,
  "2026-04-03":true,"2026-05-01":true,"2026-09-16":true,"2026-11-16":true,"2026-12-25":true,
  "2027-01-01":true,"2027-02-01":true,"2027-03-15":true,"2027-03-25":true,
  "2027-03-26":true,"2027-05-01":true,"2027-09-16":true,"2027-11-15":true,"2027-12-25":true,
};

const esDiaHabil = (d: Date) => {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !FESTIVOS[d.toISOString().slice(0, 10)];
};

const addDiasHabiles = (desde: Date, dias: number): Date => {
  const r = new Date(desde);
  let added = 0;
  while (added < dias) { r.setDate(r.getDate() + 1); if (esDiaHabil(r)) added++; }
  return r;
};

const diasHabilesRestantes = (hastaISO: string): number => {
  const hasta = new Date(fromDB(hastaISO));
  const now = new Date();
  if (hasta <= now) return 0;
  let count = 0;
  const cur = new Date(now);
  while (cur < hasta) { cur.setDate(cur.getDate() + 1); if (esDiaHabil(cur)) count++; }
  return count;
};

// Calcula fecha límite a partir de fecha de notificación + días hábiles del tipo
const calcDueDate = (fechaNotif: string, diasHabiles: number): string => {
  const [y, m, d] = fechaNotif.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  const due = addDiasHabiles(base, diasHabiles);
  return due.toISOString().slice(0, 10);
};

// ─── Dominio aduanal Manzanillo ───────────────────────────────────────────────
const CASE_TYPES = [
  { value: "pama",               label: "PAMA",                       icon: "⚠️",  plazo: 10,  base: "Art. 153 LA",   desc: "Procedimiento Administrativo en Materia Aduanera — 10 días hábiles para pruebas y alegatos" },
  { value: "recurso_revocacion", label: "Recurso de Revocación",      icon: "📋",  plazo: 30,  base: "Arts. 116-128 CFF", desc: "Impugnación de crédito fiscal ante SAT — 30 días hábiles desde notificación" },
  { value: "amparo",             label: "Amparo",                     icon: "⚖️",  plazo: 15,  base: "Art. 17 LA",    desc: "Amparo indirecto/directo contra actos SAT/AGA — 15 días hábiles" },
  { value: "nulidad",            label: "Juicio de Nulidad (TFJA)",   icon: "🏛️",  plazo: 30,  base: "Art. 13 LFPCA", desc: "Ante el Tribunal Federal de Justicia Administrativa — 30 días hábiles" },
  { value: "embargo",            label: "Embargo Precautorio",        icon: "🔒",  plazo: null, base: "Art. 151 LA",   desc: "Hasta 4 meses para regularizar — mercancía retenida en recinto fiscal" },
  { value: "pedimento_imp",      label: "Pedimento Importación",      icon: "📦",  plazo: 3,   base: "Art. 35 LA",    desc: "3 días hábiles para retiro de mercancía del recinto fiscal Manzanillo" },
  { value: "pedimento_exp",      label: "Pedimento Exportación",      icon: "🚢",  plazo: null, base: "LA",            desc: "Exportación definitiva o temporal desde Puerto de Manzanillo" },
  { value: "clasificacion",      label: "Clasificación Arancelaria",  icon: "🔍",  plazo: null, base: "TIGIE",         desc: "Disputa de fracción arancelaria ante la autoridad aduanera" },
  { value: "valoracion",         label: "Valoración en Aduana",       icon: "💰",  plazo: null, base: "Arts. 64-78 LA", desc: "Rechazo del valor declarado — inicia PAMA subsecuente" },
  { value: "deposito_fiscal",    label: "Depósito Fiscal / IMMEX",    icon: "🏭",  plazo: null, base: "Art. 119 LA",   desc: "Régimen de depósito fiscal, recinto fiscalizado o IMMEX" },
  { value: "contrabando",        label: "Contrabando / Infracción",   icon: "🚨",  plazo: null, base: "Arts. 102-109 LA", desc: "Procedimiento penal o sanción por infracción aduanera" },
  { value: "general",            label: "Asunto General",             icon: "📁",  plazo: null, base: "",              desc: "Consulta, asesoría o trámite general" },
];

const ACTION_TYPES = [
  { value: "nota",           label: "Nota interna",               icon: "📝" },
  { value: "notificacion",   label: "Notificación recibida",      icon: "📬" },
  { value: "pedimento",      label: "Pedimento presentado",       icon: "📦" },
  { value: "pruebas",        label: "Presentación de pruebas",    icon: "📎" },
  { value: "sat_tramite",    label: "Trámite SAT / AGA / VUCEM",  icon: "🏛️" },
  { value: "inspeccion",     label: "Inspección / Reconocimiento",icon: "🔍" },
  { value: "pago",           label: "Pago de contribuciones",     icon: "💳" },
  { value: "llamada",        label: "Llamada telefónica",         icon: "📞" },
  { value: "email",          label: "Correo electrónico",         icon: "📧" },
  { value: "reunion",        label: "Reunión / Junta",            icon: "🤝" },
  { value: "resolucion",     label: "Resolución recibida",        icon: "⚖️" },
  { value: "otro",           label: "Otro",                       icon: "💬" },
];

const ADUANAS = [
  { value: "220", label: "220 — Manzanillo" },
  { value: "240", label: "240 — Guadalajara" },
  { value: "300", label: "300 — AICM (México)" },
  { value: "640", label: "640 — Lázaro Cárdenas" },
  { value: "470", label: "470 — Altamira" },
  { value: "141", label: "141 — Nuevo Laredo" },
  { value: "010", label: "010 — Tijuana" },
  { value: "other", label: "Otra aduana" },
];

const REGIMENES = [
  "Definitivo de Importación",
  "Definitivo de Exportación",
  "Temporal de Importación",
  "Temporal de Exportación",
  "IMMEX — Maquiladora",
  "Depósito Fiscal",
  "Recinto Fiscalizado Estratégico",
  "Tránsito Interno",
  "Tránsito Internacional",
  "Elaboración, Transformación o Reparación",
];

const CASE_STATUSES = [
  { value: "pending", label: "Pendiente", color: "#d97706", bg: "#451a03" },
  { value: "active",  label: "Activo",    color: "#3b82f6", bg: "#1e3a5f" },
  { value: "closed",  label: "Cerrado",   color: "#10b981", bg: "#064e3b" },
];

// ─── Helpers UI ───────────────────────────────────────────────────────────────
const waLink = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return `https://wa.me/${d.startsWith("52") ? d : "52" + d}`;
};

const gcalLink = (title: string, date: string, desc = "") => {
  const d = date.slice(0, 10).replace(/-/g, "");
  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${d}/${d}`, details: desc });
  return `https://calendar.google.com/calendar/render?${params}`;
};

const gcalReminderLink = (title: string, isoRemindAt: string, desc = "") => {
  const d = new Date(fromDB(isoRemindAt));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const h = get("hour") === "24" ? "00" : get("hour");
  const fmt = (offsetMin: number) => {
    const nd = new Date(d.getTime() + offsetMin * 60000);
    const np = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(nd);
    const ng = (t: string) => np.find(p => p.type === t)?.value ?? "00";
    const nh = ng("hour") === "24" ? "00" : ng("hour");
    return `${ng("year")}${ng("month")}${ng("day")}T${nh}${ng("minute")}${ng("second")}`;
  };
  const params = new URLSearchParams({
    action: "TEMPLATE", text: `🔔 ${title}`,
    dates: `${get("year")}${get("month")}${get("day")}T${h}${get("minute")}${get("second")}/${fmt(30)}`,
    details: desc,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
};

const AVATAR_COLORS = ["#1d4ed8","#7c3aed","#0f766e","#b45309","#be185d","#1e40af","#065f46","#9f1239"];
const avatarColor = (n: string) => AVATAR_COLORS[n.charCodeAt(0) % AVATAR_COLORS.length];
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();

// ─── Types ────────────────────────────────────────────────────────────────────
type CaseType = {
  id: number; title: string; description: string; status: string;
  due_date: string; priority: string; case_type: string;
  pedimento: string; fraccion_arancelaria: string; bl_number: string;
  valor_mercancia: number; aduana: string; regimen_aduanero: string;
  fecha_notificacion: string; user_id: string;
  clients?: { id: number; name: string; phone: string; email: string };
  actions?: { id: number; note: string; action_type: string; created_at: string }[];
};
type Client = {
  id: number; name: string; phone: string; email: string; created_at: string;
  cases?: { id: number; title: string; status: string; case_type: string }[];
};
type Reminder = {
  id: number; case_id: number; remind_at: string; sent: boolean;
  created_at: string; retry_count?: number;
  cases?: { id: number; title: string; case_type?: string; pedimento?: string; clients?: { name: string; phone: string } };
};
type ActionInput = { note: string; action_type: string };

// ─── Urgency ──────────────────────────────────────────────────────────────────
const urgency = (due_date: string): "critico" | "urgente" | "proximo" | "ok" | "none" => {
  if (!due_date) return "none";
  const todayMX = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const dueStr = due_date.slice(0, 10);
  if (dueStr < todayMX) return "critico";
  const dh = diasHabilesRestantes(due_date);
  if (dh === 0) return "critico";
  if (dh <= 3)  return "urgente";
  if (dh <= 7)  return "proximo";
  return "ok";
};

const URGENCY_CFG = {
  critico: { label: "CRÍTICO",    dot: "#ef4444", text: "#fca5a5", bg: "#450a0a", border: "#ef4444" },
  urgente: { label: "Urgente",    dot: "#f97316", text: "#fdba74", bg: "#431407", border: "#f97316" },
  proximo: { label: "Próximo",    dot: "#eab308", text: "#fde047", bg: "#422006", border: "#eab308" },
  ok:      { label: "En tiempo",  dot: "#22c55e", text: "#86efac", bg: "#052e16", border: "#22c55e" },
  none:    { label: "Sin plazo",  dot: "#475569", text: "#94a3b8", bg: "#0f172a", border: "#334155" },
};

// ─── Gráfica SVG — actividad últimos 6 meses ─────────────────────────────────
function CasesChart({ cases }: { cases: any[] }) {
  const months: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-MX", { month: "short" });
    months.push({ key, label });
  }

  const counts = months.map(m => ({
    ...m,
    total:       cases.filter(c => c.due_date?.startsWith(m.key)).length,
    criticos:    cases.filter(c => c.due_date?.startsWith(m.key) && c.status !== "closed" && new Date(c.due_date) < now).length,
    cerrados:    cases.filter(c => c.due_date?.startsWith(m.key) && c.status === "closed").length,
  }));

  const maxVal = Math.max(...counts.map(c => c.total), 1);
  const W = 520; const H = 140; const BAR_W = 54; const GAP = 20;
  const BAR_AREA_H = 100;

  return (
    <div style={{ background: "#0d1829", border: "1px solid #1a2842", borderRadius: 12, padding: "20px 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>📈 Actividad por mes</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        {counts.map((m, i) => {
          const x = i * (BAR_W + GAP) + GAP;
          const totalH = Math.round((m.total / maxVal) * BAR_AREA_H);
          const cerH   = Math.round((m.cerrados / maxVal) * BAR_AREA_H);
          const critH  = Math.round((m.criticos / maxVal) * BAR_AREA_H);
          const y = BAR_AREA_H - totalH + 10;
          return (
            <g key={m.key}>
              {/* Barra total */}
              {totalH > 0 && <rect x={x} y={y} width={BAR_W} height={totalH} rx={4} fill="#1e3a5f" />}
              {/* Barra cerrados */}
              {cerH > 0 && <rect x={x} y={BAR_AREA_H - cerH + 10} width={BAR_W} height={cerH} rx={4} fill="#10b981" />}
              {/* Barra críticos */}
              {critH > 0 && <rect x={x} y={BAR_AREA_H - critH + 10} width={BAR_W} height={critH} rx={4} fill="#ef4444" opacity={0.8} />}
              {/* Valor */}
              {m.total > 0 && <text x={x + BAR_W / 2} y={y - 4} textAnchor="middle" fill="#94a3b8" fontSize={11}>{m.total}</text>}
              {/* Label mes */}
              <text x={x + BAR_W / 2} y={H - 2} textAnchor="middle" fill="#475569" fontSize={11}>{m.label}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
        {[["#1e3a5f","Total"], ["#10b981","Cerrados"], ["#ef4444","Vencidos"]].map(([color, label]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748b" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Formulario nuevo expediente ─────────────────────────────────────────────
function NuevoExpedienteForm({ clients, newCase, setNewCase, selectedClient, selectedCaseType, creating, createCase, handleCaseTypeChange, handleNotifChange, setActiveNav, waLink }: any) {
  const FL = { fontSize: 12, fontWeight: 600, color: "#e2e8f0", marginBottom: 4, display: "block" as const };
  const SEC = { borderTop: "1px solid #1a2842", paddingTop: 16, marginTop: 4 };
  const inp = { background: "#060d1a", border: "1px solid #1a2842", borderRadius: 8, padding: "9px 12px", color: "#f1f5f9", fontSize: 13, outline: "none" };
  const sel = { ...inp, cursor: "pointer" };

  return (
    <section style={{ background: "#0d1829", border: "1px solid #1a2842", borderRadius: 12, padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
        <span>➕</span><span>Nuevo expediente</span>
      </div>
      {clients.length === 0 ? (
        <div style={{ fontSize: 13, color: "#475569" }}>
          Primero registra un cliente en{" "}
          <button onClick={() => setActiveNav("clientes")} style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: 13 }}>👥 Clientes</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

          {/* Sección 1 — Tipo de asunto */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 12 }}>Tipo de asunto</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const, alignItems: "flex-end" }}>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: "1 1 200px" }}>
                <label style={FL}>Tipo de procedimiento *</label>
                <select value={newCase.case_type} onChange={e => handleCaseTypeChange(e.target.value)}
                  style={{ ...sel, borderColor: selectedCaseType?.plazo ? "#2563eb" : "#1a2842" }}>
                  {CASE_TYPES.map((t: any) => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: "1 1 160px" }}>
                <label style={FL}>Cliente *</label>
                <select value={newCase.client_id} onChange={e => setNewCase((p: any) => ({ ...p, client_id: e.target.value }))} style={sel}>
                  <option value="">Seleccionar cliente</option>
                  {clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: "2 1 220px" }}>
                <label style={FL}>Título del expediente *</label>
                <input placeholder="Ej. PAMA — Contenedor MSCU1234" value={newCase.title}
                  onChange={e => setNewCase((p: any) => ({ ...p, title: e.target.value }))}
                  style={{ ...inp, width: "100%" }} />
              </div>
            </div>
            {selectedCaseType && selectedCaseType.value !== "general" && (
              <div style={{ marginTop: 10, padding: "8px 12px", background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 8, display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center" }}>
                <span style={{ color: "#38bdf8", fontWeight: 700, fontSize: 13 }}>{selectedCaseType.icon} {selectedCaseType.label}</span>
                {selectedCaseType.plazo && <span style={{ color: "#f59e0b", fontWeight: 600, fontSize: 13 }}>· {selectedCaseType.plazo} días hábiles</span>}
                <span style={{ color: "#475569", fontSize: 12 }}>· {selectedCaseType.base} — {selectedCaseType.desc}</span>
              </div>
            )}
          </div>

          {/* Sección 2 — Fechas */}
          <div style={{ ...SEC, marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 12 }}>📅 Fechas y plazos</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const }}>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>Fecha de notificación</label>
                <input type="date" value={newCase.fecha_notificacion} onChange={e => handleNotifChange(e.target.value)} style={inp} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>Plazo legal de vencimiento{selectedCaseType?.plazo ? ` (auto — ${selectedCaseType.plazo} DH)` : ""}</label>
                <input type="date" value={newCase.due_date} onChange={e => setNewCase((p: any) => ({ ...p, due_date: e.target.value }))}
                  style={{ ...inp, borderColor: newCase.due_date ? "#2563eb" : "#1a2842" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>Aduana</label>
                <select value={newCase.aduana} onChange={e => setNewCase((p: any) => ({ ...p, aduana: e.target.value }))} style={sel}>
                  {ADUANAS.map((a: any) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Sección 3 — Datos aduanales */}
          <div style={{ ...SEC, marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 12 }}>📦 Datos aduanales</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const }}>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>N° Pedimento</label>
                <input placeholder="2026-3186-0001234" value={newCase.pedimento} onChange={e => setNewCase((p: any) => ({ ...p, pedimento: e.target.value }))} style={{ ...inp, width: 190 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>Fracción arancelaria (TIGIE)</label>
                <input placeholder="8471.30.01" value={newCase.fraccion_arancelaria} onChange={e => setNewCase((p: any) => ({ ...p, fraccion_arancelaria: e.target.value }))} style={{ ...inp, width: 150 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>B/L o Guía</label>
                <input placeholder="MSC12345678" value={newCase.bl_number} onChange={e => setNewCase((p: any) => ({ ...p, bl_number: e.target.value }))} style={{ ...inp, width: 140 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <label style={FL}>Valor mercancía (MXN)</label>
                <input type="number" placeholder="0.00" value={newCase.valor_mercancia} onChange={e => setNewCase((p: any) => ({ ...p, valor_mercancia: e.target.value }))} style={{ ...inp, width: 130 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: "1 1 180px" }}>
                <label style={FL}>Régimen aduanero</label>
                <select value={newCase.regimen_aduanero} onChange={e => setNewCase((p: any) => ({ ...p, regimen_aduanero: e.target.value }))} style={sel}>
                  <option value="">Seleccionar régimen</option>
                  {REGIMENES.map((r: string) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Sección 4 — Notas + acción */}
          <div style={SEC}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 12 }}>📝 Observaciones</div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" as const }}>
              <input placeholder="Descripción o notas adicionales del expediente" value={newCase.description}
                onChange={e => setNewCase((p: any) => ({ ...p, description: e.target.value }))}
                style={{ ...inp, flex: 1, minWidth: 260 }} />
              <button onClick={createCase} disabled={creating || !newCase.title || !newCase.client_id}
                style={{ padding: "10px 22px", background: "#2563eb", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: creating || !newCase.title || !newCase.client_id ? 0.4 : 1 }}>
                {creating ? "Creando…" : "✓ Crear expediente"}
              </button>
            </div>
            {selectedClient && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, padding: "8px 12px", background: "#060d1a", borderRadius: 8, border: "1px solid #1a2842" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: avatarColor(selectedClient.name), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 700 }}>{initials(selectedClient.name)}</div>
                <span style={{ fontSize: 13, color: "#cbd5e1", fontWeight: 600 }}>{selectedClient.name}</span>
                {selectedClient.phone && (
                  <a href={waLink(selectedClient.phone)} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#4ade80", textDecoration: "none" }}>
                    <span>💬</span><span>{selectedClient.phone}</span>
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const [cases, setCases]         = useState<CaseType[]>([]);
  const [clients, setClients]     = useState<Client[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [user, setUser]           = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [activeNav, setActiveNav]       = useState("dashboard");
  const [sidebarOpen, setSidebarOpen]   = useState(true);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ expedientes: true });
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [loading, setLoading]           = useState(false);
  const [creating, setCreating]         = useState(false);

  // Case
  const [expandedCase, setExpandedCase] = useState<number | null>(null);
  const [inputs, setInputs]             = useState<Record<number, ActionInput>>({});
  const [closingCase, setClosingCase]   = useState<{ id: number; resultado: string; nota: string } | null>(null);
  const [deletingCaseId, setDeletingCaseId] = useState<number | null>(null);
  const [reminderInputs, setReminderInputs] = useState<Record<number, string>>({});
  const [caseFilter, setCaseFilter]     = useState("all");
  const [caseTypeFilter, setCaseTypeFilter] = useState("all");
  const [newCase, setNewCase] = useState({
    title: "", description: "", client_id: "", due_date: "", case_type: "general",
    pedimento: "", fraccion_arancelaria: "", bl_number: "",
    valor_mercancia: "", aduana: "220", regimen_aduanero: "", fecha_notificacion: "",
  });

  // Client
  const [clientSearch, setClientSearch]       = useState("");
  const [editingClient, setEditingClient]     = useState<Client | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<number | null>(null);
  const [newClient, setNewClient] = useState({ name: "", phone: "", email: "" });

  // Reminder
  const [reminderFilter, setReminderFilter]       = useState("pending");
  const [deletingReminderId, setDeletingReminderId] = useState<number | null>(null);
  const [newReminder, setNewReminder] = useState({ case_id: "", remind_at: "" });

  // UI
  const [updatingStatus, setUpdatingStatus] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ msg, type });
    toastRef.current = setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
      } else {
        setUser(data.user);
      }
      setAuthChecked(true);
    });
    return () => { if (toastRef.current) clearTimeout(toastRef.current); };
  }, []);

  // ─── API helper ───────────────────────────────────────────────────────────
  const api = async (path: string, opts?: RequestInit) => {
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };

  const fetchAll = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [c, cl, r] = await Promise.all([api("/cases/full"), api("/clients"), api("/reminders")]);
      setCases(Array.isArray(c) ? c : []);
      setClients(Array.isArray(cl) ? cl : []);
      setReminders(Array.isArray(r) ? r : []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (user) fetchAll(); }, [user]);

  // ─── Derived stats ────────────────────────────────────────────────────────
  const getReminderStatus = (r: Reminder) => {
    if (r.sent) return "sent";
    return new Date(fromDB(r.remind_at)) < new Date() ? "overdue" : "pending";
  };

  const criticalCases  = cases.filter(c => urgency(c.due_date) === "critico");
  const urgentCases    = cases.filter(c => urgency(c.due_date) === "urgente");
  const proximoCases   = cases.filter(c => urgency(c.due_date) === "proximo");
  const pendingRem     = reminders.filter(r => !r.sent);
  const overdueRem     = reminders.filter(r => getReminderStatus(r) === "overdue");
  const valorTotal     = cases.filter(c => c.status !== "closed" && c.valor_mercancia)
                              .reduce((a, c) => a + (c.valor_mercancia || 0), 0);
  const activeCases    = cases.filter(c => c.status !== "closed");

  // ─── Filtered lists ───────────────────────────────────────────────────────
  const filteredCases = cases.filter(c => {
    const u = urgency(c.due_date);
    const matchFilter = caseFilter === "all" || u === caseFilter ||
      (caseFilter === "closed" && c.status === "closed");
    const matchType = caseTypeFilter === "all" || c.case_type === caseTypeFilter;
    return matchFilter && matchType;
  });

  const filteredClients   = clients.filter(c => c.name.toLowerCase().includes(clientSearch.toLowerCase()));
  const filteredReminders = reminders.filter(r =>
    reminderFilter === "all" || getReminderStatus(r) === reminderFilter
  );

  // ─── Auto due_date cuando cambia tipo + fecha_notificacion ───────────────
  const handleCaseTypeChange = (ct: string) => {
    const tipo = CASE_TYPES.find(t => t.value === ct);
    let newDue = newCase.due_date;
    if (tipo?.plazo && newCase.fecha_notificacion) {
      newDue = calcDueDate(newCase.fecha_notificacion, tipo.plazo);
    }
    setNewCase(p => ({ ...p, case_type: ct, due_date: newDue }));
  };

  const handleNotifChange = (fn: string) => {
    const tipo = CASE_TYPES.find(t => t.value === newCase.case_type);
    let newDue = newCase.due_date;
    if (tipo?.plazo && fn) newDue = calcDueDate(fn, tipo.plazo);
    setNewCase(p => ({ ...p, fecha_notificacion: fn, due_date: newDue }));
  };

  // ─── Recordatorios sugeridos para tipo de caso ───────────────────────────
  const quickReminders = (caseId: number, dueDate: string) => {
    if (!dueDate) return [];
    const due = new Date(fromDB(dueDate));
    const now = new Date();
    const make = (label: string, date: Date) =>
      date > now ? { label, iso: localToISO(isoToLocal(date.toISOString())) } : null;
    return [
      make("D-7",   addDiasHabiles(new Date(due), -7)),
      make("D-3",   addDiasHabiles(new Date(due), -3)),
      make("D-1",   addDiasHabiles(new Date(due), -1)),
    ].filter(Boolean) as { label: string; iso: string }[];
  };

  // ─── CRUD ─────────────────────────────────────────────────────────────────
  const createCase = async () => {
    if (!newCase.title || !newCase.client_id) return;
    setCreating(true);
    try {
      await api("/cases", { method: "POST", body: JSON.stringify(newCase) });
      setNewCase({ title: "", description: "", client_id: "", due_date: "", case_type: "general", pedimento: "", fraccion_arancelaria: "", bl_number: "", valor_mercancia: "", aduana: "220", regimen_aduanero: "", fecha_notificacion: "" });
      await fetchAll();
      showToast("Caso creado correctamente");
    } catch { showToast("Error al crear el caso", "err"); }
    finally { setCreating(false); }
  };

  const updateCaseStatus = async (caseId: number, status: string) => {
    if (status === "closed") {
      setClosingCase({ id: caseId, resultado: "favorable", nota: "" });
      return;
    }
    setUpdatingStatus(caseId);
    try { await api(`/cases/${caseId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); await fetchAll(); }
    finally { setUpdatingStatus(null); }
  };

  const deleteCase = async (caseId: number) => {
    try {
      await api(`/cases/${caseId}`, { method: "DELETE" });
      setDeletingCaseId(null);
      await fetchAll();
      showToast("Expediente eliminado");
    } catch { showToast("Error al eliminar el expediente", "err"); }
  };

  const closeCase = async () => {
    if (!closingCase) return;
    setUpdatingStatus(closingCase.id);
    try {
      await api(`/cases/${closingCase.id}/close`, { method: "POST", body: JSON.stringify({ resultado: closingCase.resultado, nota: closingCase.nota }) });
      setClosingCase(null);
      await fetchAll();
      showToast("Expediente cerrado correctamente");
    } catch { showToast("Error al cerrar el expediente", "err"); }
    finally { setUpdatingStatus(null); }
  };

  const createClient = async () => {
    if (!newClient.name) return;
    setCreating(true);
    try {
      await api("/clients", { method: "POST", body: JSON.stringify(newClient) });
      setNewClient({ name: "", phone: "", email: "" });
      await fetchAll(); showToast("Cliente registrado");
    } catch { showToast("Error al crear cliente", "err"); }
    finally { setCreating(false); }
  };

  const updateClient = async () => {
    if (!editingClient) return;
    try {
      await api(`/clients/${editingClient.id}`, { method: "PATCH", body: JSON.stringify({ name: editingClient.name, phone: editingClient.phone, email: editingClient.email }) });
      setEditingClient(null); await fetchAll(); showToast("Cliente actualizado");
    } catch { showToast("Error al actualizar", "err"); }
  };

  const deleteClient = async (id: number) => {
    try { await api(`/clients/${id}`, { method: "DELETE" }); setDeletingClientId(null); await fetchAll(); showToast("Cliente eliminado"); }
    catch { showToast("Error al eliminar", "err"); }
  };

  const addAction = async (caseId: number) => {
    const inp = inputs[caseId];
    if (!inp?.note) return;
    try {
      await api("/actions", { method: "POST", body: JSON.stringify({ case_id: caseId, note: inp.note, action_type: inp.action_type || "nota" }) });
      setInputs(p => ({ ...p, [caseId]: { note: "", action_type: "nota" } }));
      await fetchAll(); showToast("Actuación registrada");
    } catch { showToast("Error al guardar", "err"); }
  };

  const addReminder = async (caseId: number, remindAt: string) => {
    if (!remindAt) return;
    try {
      await api("/reminders", { method: "POST", body: JSON.stringify({ case_id: caseId, remind_at: remindAt }) });
      setReminderInputs(p => ({ ...p, [caseId]: "" }));
      await fetchAll(); showToast("Recordatorio añadido");
    } catch { showToast("Error al crear recordatorio", "err"); }
  };

  const createReminder = async () => {
    if (!newReminder.case_id || !newReminder.remind_at) return;
    setCreating(true);
    try {
      await api("/reminders", { method: "POST", body: JSON.stringify({ case_id: newReminder.case_id, remind_at: localToISO(newReminder.remind_at) }) });
      setNewReminder({ case_id: "", remind_at: "" });
      await fetchAll(); showToast("Recordatorio creado");
    } catch { showToast("Error al crear recordatorio", "err"); }
    finally { setCreating(false); }
  };

  const deleteReminder = async (id: number) => {
    try { await api(`/reminders/${id}`, { method: "DELETE" }); setDeletingReminderId(null); await fetchAll(); showToast("Recordatorio eliminado"); }
    catch { showToast("Error al eliminar", "err"); }
  };

  const markReminderSent = async (id: number) => {
    try { await api(`/reminders/${id}/sent`, { method: "PATCH" }); await fetchAll(); showToast("Marcado como completado"); }
    catch { showToast("Error al actualizar", "err"); }
  };

  const selectedClient = clients.find(c => c.id === Number(newCase.client_id));
  const selectedCaseType = CASE_TYPES.find(t => t.value === newCase.case_type);

  const navItems = [
    { id: "dashboard",     label: "Dashboard" },
    { id: "casos",         label: "Expedientes" },
    { id: "casos_nuevo",   label: "Nuevo expediente" },
    { id: "juntas",        label: "Agendar junta" },
    { id: "clientes",      label: "Clientes" },
    { id: "recordatorios", label: "Recordatorios" },
  ];

  const REM_CFG: Record<string, any> = {
    pending: { label: "Pendiente", bg: "#0f2233", color: "#7dd3fc" },
    overdue: { label: "Vencido",   bg: "#2a1010", color: "#f87171" },
    sent:    { label: "Enviado",   bg: "#052e16", color: "#4ade80" },
  };

  if (!authChecked) return null;

  return (
    <div style={s.root}>
      {/* ── TOAST ── */}
      {toast && (
        <div style={{ ...s.toast, background: toast.type === "ok" ? "#052e16" : "#450a0a", borderColor: toast.type === "ok" ? "#166534" : "#991b1b" }}>
          <span style={{ color: toast.type === "ok" ? "#4ade80" : "#f87171", fontWeight: 700 }}>{toast.type === "ok" ? "✓" : "✕"}</span>
          <span style={{ color: "#e2e8f0", fontSize: 13 }}>{toast.msg}</span>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <aside style={{ ...s.sidebar, width: sidebarOpen ? 240 : 66 }}>
        <div style={s.sidebarHeader}>
          {sidebarOpen ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22 }}>⚖️</span>
              <div>
                <div style={s.logoName}>LawyerTracker</div>
                <div style={s.logoSub}>Aduana Manzanillo · Puerto 220</div>
              </div>
            </div>
          ) : <span style={{ fontSize: 22 }}>⚖️</span>}
          <button style={s.collapseBtn} onClick={() => setSidebarOpen(v => !v)}>{sidebarOpen ? "‹" : "›"}</button>
        </div>

        {/* Buscador de clientes */}
        {sidebarOpen && (
          <div style={{ padding: "0 10px 8px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#475569" }}>🔍</span>
              <input placeholder="Buscar cliente…" value={sidebarSearch}
                onChange={e => { setSidebarSearch(e.target.value); if (e.target.value) setActiveNav("clientes"); }}
                style={{ ...s.input, width: "100%", paddingLeft: 26, fontSize: 12, padding: "6px 8px 6px 26px", boxSizing: "border-box" as const }} />
            </div>
            {sidebarSearch && (
              <div style={{ background: "#0d1829", border: "1px solid #1a2842", borderRadius: 8, marginTop: 4, overflow: "hidden" }}>
                {clients.filter(c => c.name.toLowerCase().includes(sidebarSearch.toLowerCase())).slice(0, 5).map(c => (
                  <button key={c.id} onClick={() => { setClientSearch(sidebarSearch); setSidebarSearch(""); setActiveNav("clientes"); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", background: "none", border: "none", cursor: "pointer", textAlign: "left" as const }}>
                    <div style={{ ...s.avatar, background: avatarColor(c.name), width: 22, height: 22, fontSize: 9, flexShrink: 0 }}>{initials(c.name)}</div>
                    <span style={{ fontSize: 12, color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{c.name}</span>
                  </button>
                ))}
                {clients.filter(c => c.name.toLowerCase().includes(sidebarSearch.toLowerCase())).length === 0 && (
                  <div style={{ padding: "8px 10px", fontSize: 12, color: "#475569" }}>Sin resultados</div>
                )}
              </div>
            )}
          </div>
        )}

        <nav style={s.nav}>
          {/* Dashboard */}
          <button onClick={() => setActiveNav("dashboard")}
            style={{ ...s.navBtn, ...(activeNav === "dashboard" ? s.navBtnActive : {}), justifyContent: sidebarOpen ? "flex-start" : "center" }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>📊</span>
            {sidebarOpen && <span style={s.navLabel}>Dashboard</span>}
          </button>

          {/* Expedientes — sección padre */}
          {sidebarOpen ? (
            <>
              <button onClick={() => setExpandedSections(p => ({ ...p, expedientes: !p.expedientes }))}
                style={{ ...s.navBtn, justifyContent: "flex-start" }}>
                <span style={{ fontSize: 15, flexShrink: 0 }}>⚖️</span>
                <span style={s.navLabel}>Expedientes</span>
                {criticalCases.length > 0 && <span style={{ ...s.badge, background: "#ef4444", marginLeft: "auto", marginRight: 4 }}>{criticalCases.length}</span>}
                <span style={{ fontSize: 10, color: "#475569", marginLeft: criticalCases.length > 0 ? 0 : "auto" }}>{expandedSections.expedientes ? "▾" : "▸"}</span>
              </button>
              {expandedSections.expedientes && (
                <div style={{ paddingLeft: 14 }}>
                  {[
                    { id: "casos",          icon: "📂", label: "Ver expedientes" },
                    { id: "casos_nuevo",    icon: "➕", label: "Nuevo expediente" },
                    { id: "juntas",         icon: "🤝", label: "Agendar junta" },
                  ].map(sub => (
                    <button key={sub.id} onClick={() => setActiveNav(sub.id)}
                      style={{ ...s.navBtn, ...(activeNav === sub.id ? s.navBtnActive : {}), fontSize: 12, padding: "6px 10px", justifyContent: "flex-start" }}>
                      <span style={{ fontSize: 13 }}>{sub.icon}</span>
                      <span style={{ ...s.navLabel, fontSize: 12 }}>{sub.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <button onClick={() => setActiveNav("casos")}
              style={{ ...s.navBtn, ...(["casos","casos_nuevo","juntas"].includes(activeNav) ? s.navBtnActive : {}), justifyContent: "center" }}>
              <span style={{ fontSize: 15 }}>⚖️</span>
            </button>
          )}

          {/* Clientes */}
          <button onClick={() => setActiveNav("clientes")}
            style={{ ...s.navBtn, ...(activeNav === "clientes" ? s.navBtnActive : {}), justifyContent: sidebarOpen ? "flex-start" : "center" }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>👥</span>
            {sidebarOpen && <span style={s.navLabel}>Clientes</span>}
          </button>

          {/* Recordatorios */}
          <button onClick={() => setActiveNav("recordatorios")}
            style={{ ...s.navBtn, ...(activeNav === "recordatorios" ? s.navBtnActive : {}), justifyContent: sidebarOpen ? "flex-start" : "center" }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>🔔</span>
            {sidebarOpen && <span style={s.navLabel}>Recordatorios</span>}
            {overdueRem.length > 0 && (
              <span style={{ ...s.badge, background: "#f97316", marginLeft: sidebarOpen ? "auto" : 0 }}>{overdueRem.length}</span>
            )}
          </button>
        </nav>

        <div style={s.sidebarFooter}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px" }}>
            <div style={{ ...s.avatar, background: user ? avatarColor(user.email) : "#1e2d45", width: 32, height: 32, fontSize: 12 }}>
              {user?.email?.[0]?.toUpperCase() ?? "?"}
            </div>
            {sidebarOpen && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>{user?.email?.split("@")[0]}</div>
                <div style={{ fontSize: 10, color: "#334155" }}>Abogado aduanal</div>
              </div>
            )}
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = "/login"; }}
            style={{ ...s.logoutBtn, justifyContent: sidebarOpen ? "flex-start" : "center" }}>
            <span>🚪</span>{sidebarOpen && <span>Cerrar sesión</span>}
          </button>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main style={s.main}>
        <header style={s.topbar}>
          <div>
            <h1 style={s.pageTitle}>{navItems.find(n => n.id === activeNav)?.label}</h1>
            <div style={s.breadcrumb}>LawyerTracker › {navItems.find(n => n.id === activeNav)?.label}</div>
          </div>
          {loading && <span style={{ fontSize: 12, color: "#475569" }}>⏳ Actualizando…</span>}
        </header>

        <div style={s.contentWrap}>

          {/* ══════ DASHBOARD ══════ */}
          {activeNav === "dashboard" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

              {/* KPI Grid */}
              <div style={s.kpiGrid}>
                <KPI icon="🔴" label="CASOS CRÍTICOS" value={criticalCases.length} color="#f87171" bg="#450a0a" border="#991b1b"
                  sub={criticalCases.length > 0 ? criticalCases.slice(0,2).map(c=>c.title).join(", ") : "Ninguno"} onClick={() => { setActiveNav("casos"); setCaseFilter("critico"); }} />
                <KPI icon="🟠" label="URGENTES (≤3 DH)" value={urgentCases.length} color="#fdba74" bg="#431407" border="#c2410c"
                  sub="Días hábiles restantes ≤ 3" onClick={() => { setActiveNav("casos"); setCaseFilter("urgente"); }} />
                <KPI icon="⏰" label="PRÓXIMOS (≤7 DH)" value={proximoCases.length} color="#fde047" bg="#422006" border="#a16207"
                  sub="Vencen esta semana" onClick={() => { setActiveNav("casos"); setCaseFilter("proximo"); }} />
                <KPI icon="💰" label="VALOR EN DISPUTA" value={`$${(valorTotal/1000).toFixed(0)}k`} color="#86efac" bg="#052e16" border="#166534"
                  sub="MXN — expedientes activos" onClick={() => {}} />
                <KPI icon="🔔" label="RECORDATORIOS" value={pendingRem.length} color="#7dd3fc" bg="#0c1f3a" border="#1e4080"
                  sub={`${overdueRem.length} vencido${overdueRem.length !== 1 ? "s" : ""}`} onClick={() => setActiveNav("recordatorios")} />
                <KPI icon="📂" label="EXPEDIENTES ACTIVOS" value={activeCases.length} color="#c4b5fd" bg="#1e1047" border="#4c1d95"
                  sub={`${cases.filter(c=>c.status==="closed").length} cerrados`} onClick={() => setActiveNav("casos")} />
              </div>

              {/* Casos críticos / urgentes */}
              {(criticalCases.length > 0 || urgentCases.length > 0) && (
                <div style={s.dashSection}>
                  <div style={s.dashSectionTitle}>⚠️ Requieren atención inmediata</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[...criticalCases, ...urgentCases].slice(0, 6).map(c => {
                      const u = urgency(c.due_date);
                      const cfg = URGENCY_CFG[u];
                      const tipo = CASE_TYPES.find(t => t.value === c.case_type);
                      const dh = c.due_date ? diasHabilesRestantes(c.due_date) : null;
                      return (
                        <div key={c.id} style={{ ...s.dashCaseRow, borderLeftColor: cfg.border }}
                          onClick={() => { setActiveNav("casos"); setExpandedCase(c.id); }}>
                          <span style={{ fontSize: 16 }}>{tipo?.icon ?? "📁"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>{c.title}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>
                              {tipo?.label} · {c.clients?.name}
                              {c.pedimento && ` · Ped. ${c.pedimento}`}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: cfg.text }}>
                              {dh !== null ? `${dh} día${dh !== 1 ? "s" : ""} hábil${dh !== 1 ? "es" : ""}` : cfg.label}
                            </div>
                            {c.due_date && <div style={{ fontSize: 10, color: "#475569" }}>{fmtDateOnly(c.due_date)}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Distribución por tipo */}
              <div style={s.dashSection}>
                <div style={s.dashSectionTitle}>📊 Expedientes por tipo de procedimiento</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {CASE_TYPES.filter(t => t.value !== "general").map(t => {
                    const count = activeCases.filter(c => c.case_type === t.value).length;
                    if (count === 0) return null;
                    return (
                      <div key={t.value} style={s.typeChip}
                        onClick={() => { setActiveNav("casos"); setCaseTypeFilter(t.value); }}>
                        <span>{t.icon}</span>
                        <span style={{ fontWeight: 600, color: "#f1f5f9" }}>{count}</span>
                        <span style={{ color: "#94a3b8" }}>{t.label}</span>
                      </div>
                    );
                  })}
                  {activeCases.filter(c => c.case_type === "general").length > 0 && (
                    <div style={s.typeChip}>
                      <span>📁</span>
                      <span style={{ fontWeight: 600, color: "#f1f5f9" }}>{activeCases.filter(c=>c.case_type==="general").length}</span>
                      <span style={{ color: "#94a3b8" }}>General</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Próximos recordatorios */}
              {pendingRem.length > 0 && (
                <div style={s.dashSection}>
                  <div style={s.dashSectionTitle}>🔔 Próximos recordatorios</div>
                  {pendingRem.slice(0, 5).map(r => (
                    <div key={r.id} style={{ ...s.dashCaseRow, borderLeftColor: getReminderStatus(r) === "overdue" ? "#ef4444" : "#3b82f6", cursor: "default" }}>
                      <span style={{ fontSize: 14 }}>🔔</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>{r.cases?.title ?? "Caso eliminado"}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>{r.cases?.clients?.name}</div>
                      </div>
                      <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                        <div style={{ fontSize: 12, color: "#38bdf8" }}>{fmtDateTime(r.remind_at)}</div>
                        <div style={{ fontSize: 11, color: getReminderStatus(r) === "overdue" ? "#f87171" : "#475569" }}>
                          {timeUntil(r.remind_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Gráfica — actividad últimos 6 meses */}
              <CasesChart cases={cases} />

            </div>
          )}

          {/* ══════ NUEVO EXPEDIENTE (ruta directa desde sidebar) ══════ */}
          {activeNav === "casos_nuevo" && (
            <NuevoExpedienteForm
              clients={clients} newCase={newCase} setNewCase={setNewCase}
              selectedClient={selectedClient} selectedCaseType={selectedCaseType}
              creating={creating} createCase={createCase}
              handleCaseTypeChange={handleCaseTypeChange} handleNotifChange={handleNotifChange}
              setActiveNav={setActiveNav} waLink={waLink}
            />
          )}

          {/* ══════ AGENDAR JUNTA ══════ */}
          {activeNav === "juntas" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
              <div style={s.formCardTitle}><span>🤝</span><span>Agendar junta con cliente</span></div>
              <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Selecciona un expediente y genera el evento en Google Calendar directamente.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {activeCases.map(c => {
                  const tipo = CASE_TYPES.find(t => t.value === c.case_type);
                  const juntaLink = (date: string) => {
                    const d = date.replace(/-/g, "");
                    const params = new URLSearchParams({
                      action: "TEMPLATE",
                      text: `Junta — ${c.title}`,
                      dates: `${d}T100000/${d}T110000`,
                      details: `${tipo?.label ?? ""}\nCliente: ${c.clients?.name ?? ""}\n${c.pedimento ? "Pedimento: " + c.pedimento : ""}`,
                      ...(c.clients?.email ? { add: c.clients.email } : {}),
                    });
                    return `https://calendar.google.com/calendar/render?${params}`;
                  };
                  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
                  return (
                    <div key={c.id} style={{ ...s.caseCard, borderLeftColor: "#2563eb" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>{tipo?.icon} {c.title}</div>
                          <div style={{ fontSize: 12, color: "#64748b", marginTop: 3 }}>{c.clients?.name} {c.clients?.phone && `· ${c.clients.phone}`}</div>
                        </div>
                        <a href={juntaLink(today)} target="_blank" rel="noreferrer"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "#0a1e3d", border: "1px solid #1e3a6e", borderRadius: 8, color: "#4285f4", fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" as const }}>
                          📅 Agendar junta
                        </a>
                      </div>
                    </div>
                  );
                })}
                {activeCases.length === 0 && <div style={s.emptyState}>No hay expedientes activos</div>}
              </div>
            </div>
          )}

          {/* ══════ EXPEDIENTES ══════ */}
          {activeNav === "casos" && (
            <>
              {/* Formulario nuevo caso */}
              <NuevoExpedienteForm
                clients={clients} newCase={newCase} setNewCase={setNewCase}
                selectedClient={selectedClient} selectedCaseType={selectedCaseType}
                creating={creating} createCase={createCase}
                handleCaseTypeChange={handleCaseTypeChange} handleNotifChange={handleNotifChange}
                setActiveNav={setActiveNav} waLink={waLink}
              />

              {/* Filtros */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <FilterGroup
                  items={[{ id: "all", label: "Todos" }, { id: "critico", label: "🔴 Críticos" }, { id: "urgente", label: "🟠 Urgentes" }, { id: "proximo", label: "🟡 Próximos" }, { id: "ok", label: "✅ En tiempo" }, { id: "closed", label: "📁 Cerrados" }]}
                  active={caseFilter} onChange={setCaseFilter}
                />
                <select value={caseTypeFilter} onChange={e => setCaseTypeFilter(e.target.value)} style={{ ...s.select, fontSize: 12 }}>
                  <option value="all">Todos los tipos</option>
                  {CASE_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
                </select>
              </div>

              {/* Lista de expedientes */}
              {filteredCases.length === 0 ? (
                <div style={s.emptyState}>⚖️ No hay expedientes en esta categoría</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredCases.map(c => {
                    const u = urgency(c.due_date);
                    const cfg = URGENCY_CFG[u];
                    const st = CASE_STATUSES.find(s => s.value === c.status) ?? CASE_STATUSES[0];
                    const tipo = CASE_TYPES.find(t => t.value === c.case_type);
                    const inp = inputs[c.id] ?? { note: "", action_type: "nota" };
                    const isExpanded = expandedCase === c.id;
                    const dh = c.due_date ? diasHabilesRestantes(c.due_date) : null;
                    const caseRem = reminders.filter(r => r.case_id === c.id && !r.sent);
                    const qr = quickReminders(c.id, c.due_date);

                    return (
                      <article key={c.id} style={{ ...s.caseCard, borderLeftColor: cfg.border }}>
                        {/* Header */}
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 15 }}>{tipo?.icon ?? "📁"}</span>
                              <h3 style={s.caseTitle}>{c.title}</h3>
                              <select value={c.status ?? "pending"} onChange={e => updateCaseStatus(c.id, e.target.value)}
                                disabled={updatingStatus === c.id}
                                style={{ ...s.statusPill, background: st.bg, color: st.color }}>
                                {CASE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                              </select>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                              <div style={{ ...s.avatar, background: avatarColor(c.clients?.name ?? "?"), width: 20, height: 20, fontSize: 9 }}>
                                {initials(c.clients?.name ?? "?")}
                              </div>
                              <span style={{ fontSize: 13, color: "#cbd5e1" }}>{c.clients?.name}</span>
                              {c.clients?.phone && (
                                <a href={waLink(c.clients.phone)} target="_blank" rel="noreferrer" style={s.waLink}><span>💬</span><span>{c.clients.phone}</span></a>
                              )}
                              {tipo && <span style={s.tipoPill}>{tipo.icon} {tipo.label}</span>}
                            </div>

                            {/* Datos aduanales */}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                              {c.aduana     && <DataTag label="Aduana"    value={ADUANAS.find(a=>a.value===c.aduana)?.label || c.aduana} />}
                              {c.pedimento  && <DataTag label="Pedimento" value={c.pedimento} />}
                              {c.fraccion_arancelaria && <DataTag label="Fracción" value={c.fraccion_arancelaria} />}
                              {c.bl_number  && <DataTag label="B/L"       value={c.bl_number} />}
                              {c.regimen_aduanero && <DataTag label="Régimen" value={c.regimen_aduanero} />}
                              {c.valor_mercancia && <DataTag label="Valor" value={`$${Number(c.valor_mercancia).toLocaleString("es-MX")} MXN`} highlight />}
                            </div>

                            {c.description && <p style={s.caseDesc}>{c.description}</p>}
                          </div>

                          {/* Lado derecho: urgencia + plazo */}
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                            <div style={{ ...s.urgencyBadge, background: cfg.bg, borderColor: cfg.border }}>
                              <span style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.dot, flexShrink: 0 }} />
                              <span style={{ color: cfg.text, fontWeight: 700, fontSize: 11 }}>{cfg.label}</span>
                            </div>
                            {c.due_date && (
                              <div style={{ textAlign: "right" as const }}>
                                <div style={{ fontSize: 12, color: cfg.text, fontWeight: 600 }}>
                                  {dh !== null && dh >= 0 ? `${dh} día${dh !== 1 ? "s" : ""} hábil${dh !== 1 ? "es" : ""}` : "Vencido"}
                                </div>
                                <div style={{ fontSize: 11, color: "#475569" }}>{fmtDateOnly(c.due_date)}</div>
                                {tipo?.plazo && <div style={{ fontSize: 10, color: "#334155" }}>Plazo: {tipo.plazo} DH · {tipo.base}</div>}
                                <a href={gcalLink(c.title, c.due_date, `${tipo?.label ?? ""} — ${c.pedimento ?? ""}\n${c.description ?? ""}`)}
                                  target="_blank" rel="noreferrer"
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, fontSize: 11, color: "#4285f4", textDecoration: "none", background: "#0a1628", border: "1px solid #1e3a6e", borderRadius: 6, padding: "2px 7px" }}>
                                  📅 Agregar a Google Calendar
                                </a>
                              </div>
                            )}
                            {caseRem.length > 0 && (
                              <span style={{ fontSize: 11, background: "#2a1f06", color: "#fbbf24", borderRadius: 20, padding: "2px 8px", border: "1px solid #854d0e" }}>
                                🔔 {caseRem.length} recordatorio{caseRem.length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Panel de cierre inline */}
                        {closingCase?.id === c.id && (
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", background: "#1a0a00", border: "1px solid #7c2d12", borderRadius: 8, marginTop: 10 }}>
                            <span style={{ fontSize: 12, color: "#fb923c", fontWeight: 700, whiteSpace: "nowrap" }}>✓ Cerrar expediente</span>
                            <select autoFocus value={closingCase.resultado}
                              onChange={e => setClosingCase(p => p && { ...p, resultado: e.target.value })}
                              style={{ ...s.select, fontSize: 12, flexShrink: 0 }}>
                              <option value="favorable">Favorable al cliente</option>
                              <option value="desfavorable">Desfavorable</option>
                              <option value="sobreseido">Sobreseído</option>
                              <option value="desistido">Desistido / Retirado</option>
                              <option value="acuerdo">Acuerdo / Convenio</option>
                              <option value="prescrito">Prescrito / Caducado</option>
                              <option value="sin_resolucion">Sin resolución formal</option>
                            </select>
                            <input placeholder="Nota de cierre (opcional)" value={closingCase.nota}
                              onChange={e => setClosingCase(p => p && { ...p, nota: e.target.value })}
                              onKeyDown={e => { if (e.key === "Enter") closeCase(); if (e.key === "Escape") setClosingCase(null); }}
                              style={{ ...s.input, flex: 1, minWidth: 180, margin: 0, fontSize: 12 }} />
                            <button onClick={closeCase} disabled={updatingStatus === c.id}
                              style={{ ...s.dangerBtn, background: "#7c2d12", borderColor: "#9a3412", whiteSpace: "nowrap" }}>
                              {updatingStatus === c.id ? "Cerrando…" : "Confirmar cierre"}
                            </button>
                            <button onClick={() => setClosingCase(null)} style={{ ...s.ghostBtn, fontSize: 12 }}>Cancelar</button>
                          </div>
                        )}

                        {/* Toggle actuaciones */}
                        <button style={s.expandBtn} onClick={() => setExpandedCase(isExpanded ? null : c.id)}>
                          <span style={{ color: "#475569", fontSize: 12 }}>
                            {isExpanded ? "▲ Ocultar" : "▼ Ver actuaciones"}{c.actions?.length ? ` (${c.actions.length})` : ""}
                          </span>
                        </button>

                        {isExpanded && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid #131f33", paddingTop: 14 }}>
                            {/* Log */}
                            {c.actions && c.actions.length > 0 && (
                              <div style={s.actionLog}>
                                {[...c.actions].reverse().map((a: any) => {
                                  const at = ACTION_TYPES.find(t => t.value === a.action_type);
                                  return (
                                    <div key={a.id} style={s.actionItem}>
                                      <span style={{ fontSize: 14, flexShrink: 0 }}>{at?.icon ?? "📝"}</span>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <span style={s.actionLabel}>{at?.label ?? "Nota"}</span>
                                        <p style={s.actionNote}>{a.note}</p>
                                      </div>
                                      <span style={s.actionAge}>{timeAgo(a.created_at)}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Agregar actuación */}
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <select value={inp.action_type}
                                onChange={e => setInputs(p => ({ ...p, [c.id]: { ...inp, action_type: e.target.value } }))}
                                style={{ ...s.select, fontSize: 12, flexShrink: 0 }}>
                                {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
                              </select>
                              <input placeholder="Registrar actuación procesal…" value={inp.note}
                                onChange={e => setInputs(p => ({ ...p, [c.id]: { ...inp, note: e.target.value } }))}
                                onKeyDown={e => e.key === "Enter" && addAction(c.id)}
                                style={{ ...s.input, flex: 1, margin: 0 }} />
                              <button onClick={() => addAction(c.id)} disabled={!inp.note}
                                style={{ ...s.greenBtn, opacity: inp.note ? 1 : 0.4 }}>Guardar</button>
                            </div>

                            {/* Recordatorios */}
                            <div style={{ borderTop: "1px solid #131f33", paddingTop: 12 }}>
                              <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>🔔 Recordatorio para este expediente</div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <input type="datetime-local" value={reminderInputs[c.id] ?? ""}
                                  onChange={e => setReminderInputs(p => ({ ...p, [c.id]: e.target.value }))}
                                  style={{ ...s.input, flex: 1, margin: 0, fontSize: 12 }} />
                                <button onClick={() => addReminder(c.id, localToISO(reminderInputs[c.id]))}
                                  disabled={!reminderInputs[c.id]}
                                  style={{ ...s.purpleBtn, opacity: reminderInputs[c.id] ? 1 : 0.4 }}>+ Añadir</button>
                                {reminderInputs[c.id] && (
                                  <a href={gcalReminderLink(c.title, localToISO(reminderInputs[c.id]), `${CASE_TYPES.find(t => t.value === c.case_type)?.label ?? ""}\n${c.pedimento ? "Pedimento: " + c.pedimento : ""}`)}
                                    target="_blank" rel="noreferrer"
                                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", background: "#0a1628", border: "1px solid #1e3a6e", borderRadius: 6, color: "#4285f4", fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" as const }}>
                                    📅 Google Cal
                                  </a>
                                )}
                              </div>
                              {/* Recordatorios sugeridos basados en el plazo */}
                              {qr.length > 0 && (
                                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 11, color: "#475569" }}>Sugeridos:</span>
                                  {qr.map(r => (
                                    <button key={r.label} onClick={() => addReminder(c.id, r.iso)}
                                      style={s.quickRemBtn}>
                                      ⚡ {r.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Eliminar expediente */}
                            <div style={{ borderTop: "1px solid #131f33", paddingTop: 10 }}>
                              {deletingCaseId === c.id ? (
                                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 12, color: "#f87171", fontWeight: 600 }}>¿Eliminar este expediente? Esta acción no se puede deshacer.</span>
                                  <button onClick={() => deleteCase(c.id)} style={{ ...s.dangerBtn, fontSize: 12, padding: "5px 12px" }}>Sí, eliminar</button>
                                  <button onClick={() => setDeletingCaseId(null)} style={{ ...s.ghostBtn, fontSize: 12 }}>Cancelar</button>
                                </div>
                              ) : (
                                <button onClick={() => setDeletingCaseId(c.id)}
                                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#475569", padding: 0 }}>
                                  🗑️ Eliminar expediente
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ══════ CLIENTES ══════ */}
          {activeNav === "clientes" && (
            <>
              <section style={s.formCard}>
                <div style={s.formCardTitle}><span>➕</span><span>Nuevo cliente</span></div>
                <div style={s.formRow}>
                  <input placeholder="Nombre completo *" value={newClient.name}
                    onChange={e => setNewClient(p => ({ ...p, name: e.target.value }))}
                    onKeyDown={e => e.key === "Enter" && createClient()}
                    style={{ ...s.input, flex: 2, minWidth: 180 }} />
                  <input placeholder="Teléfono" value={newClient.phone}
                    onChange={e => setNewClient(p => ({ ...p, phone: e.target.value }))}
                    style={{ ...s.input, flex: 1, minWidth: 130 }} />
                  <input placeholder="Email" value={newClient.email}
                    onChange={e => setNewClient(p => ({ ...p, email: e.target.value }))}
                    style={{ ...s.input, flex: 2, minWidth: 180 }} />
                  <button onClick={createClient} disabled={creating || !newClient.name}
                    style={{ ...s.primaryBtn, opacity: creating || !newClient.name ? 0.45 : 1 }}>
                    {creating ? "Creando…" : "Registrar cliente"}
                  </button>
                </div>
              </section>

              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13 }}>🔍</span>
                <input placeholder="Buscar cliente…" value={clientSearch}
                  onChange={e => setClientSearch(e.target.value)}
                  style={{ ...s.input, paddingLeft: 30, width: 240 }} />
              </div>

              {filteredClients.length === 0 ? (
                <div style={s.emptyState}>{clientSearch ? "🔍 Sin resultados" : "👥 No hay clientes registrados"}</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredClients.map(client => (
                    <article key={client.id} style={s.clientCard}>
                      {editingClient?.id === client.id ? (
                        <div>
                          <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "#64748b" }}>✏️ Editando cliente</p>
                          <div style={s.formRow}>
                            <input value={editingClient.name} onChange={e => setEditingClient(p => p && { ...p, name: e.target.value })} style={{ ...s.input, flex: 2 }} placeholder="Nombre *" />
                            <input value={editingClient.phone ?? ""} onChange={e => setEditingClient(p => p && { ...p, phone: e.target.value })} style={{ ...s.input, flex: 1 }} placeholder="Teléfono" />
                            <input value={editingClient.email ?? ""} onChange={e => setEditingClient(p => p && { ...p, email: e.target.value })} style={{ ...s.input, flex: 2 }} placeholder="Email" />
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                            <button onClick={updateClient} style={s.primaryBtn}>💾 Guardar</button>
                            <button onClick={() => setEditingClient(null)} style={s.ghostBtn}>Cancelar</button>
                          </div>
                        </div>
                      ) : deletingClientId === client.id ? (
                        <div>
                          <p style={{ margin: 0, color: "#f87171", fontWeight: 600 }}>¿Eliminar a {client.name}?</p>
                          <p style={{ margin: "4px 0 12px", fontSize: 12, color: "#64748b" }}>Esta acción no se puede deshacer.</p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => deleteClient(client.id)} style={s.dangerBtn}>Sí, eliminar</button>
                            <button onClick={() => setDeletingClientId(null)} style={s.ghostBtn}>Cancelar</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                          <div style={{ ...s.avatar, background: avatarColor(client.name), width: 46, height: 46, fontSize: 17, flexShrink: 0 }}>{initials(client.name)}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#f1f5f9" }}>{client.name}</h3>
                            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 5, flexWrap: "wrap" }}>
                              {client.phone && <a href={waLink(client.phone)} target="_blank" rel="noreferrer" style={s.waLink}><span>💬</span><span>{client.phone}</span></a>}
                              {client.email && <span style={{ fontSize: 12, color: "#64748b" }}>📧 {client.email}</span>}
                              <span style={{ fontSize: 11, color: "#334155" }}>Desde {fmtDate(client.created_at, { month: "short", year: "numeric" })}</span>
                            </div>
                            {client.cases && client.cases.length > 0 ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                                {client.cases.map(cs => {
                                  const t = CASE_TYPES.find(t => t.value === cs.case_type);
                                  const csSt = CASE_STATUSES.find(s => s.value === cs.status);
                                  return (
                                    <span key={cs.id} style={{ background: "transparent", border: `1px solid ${csSt?.color ?? "#334155"}`, borderRadius: 20, padding: "2px 10px", fontSize: 11, color: "#94a3b8" }}>
                                      {t?.icon ?? "📁"} {cs.title}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : <span style={{ display: "block", marginTop: 8, fontSize: 11, color: "#1e2d45" }}>Sin expedientes asociados</span>}
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button onClick={() => setEditingClient(client)} style={s.iconBtn}>✏️</button>
                            <button onClick={() => setDeletingClientId(client.id)} style={s.iconBtn}>🗑️</button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ══════ RECORDATORIOS ══════ */}
          {activeNav === "recordatorios" && (
            <>
              <section style={s.formCard}>
                <div style={s.formCardTitle}><span>🔔</span><span>Nuevo recordatorio</span></div>
                {cases.length === 0 ? (
                  <div style={s.emptyHint}>Primero crea un expediente en <button onClick={() => setActiveNav("casos")} style={s.linkBtn}>⚖️ Expedientes</button></div>
                ) : (
                  <div style={s.formRow}>
                    <select value={newReminder.case_id} onChange={e => setNewReminder(p => ({ ...p, case_id: e.target.value }))}
                      style={{ ...s.select, flex: 2, minWidth: 220 }}>
                      <option value="">⚖️ Seleccionar expediente *</option>
                      {cases.map(c => {
                        const t = CASE_TYPES.find(t => t.value === c.case_type);
                        return <option key={c.id} value={c.id}>{t?.icon} {c.title} — {c.clients?.name ?? "Sin cliente"}</option>;
                      })}
                    </select>
                    <input type="datetime-local" value={newReminder.remind_at}
                      onChange={e => setNewReminder(p => ({ ...p, remind_at: e.target.value }))}
                      style={{ ...s.input, flex: "none" as any, width: 200 }} />
                    <button onClick={createReminder}
                      disabled={creating || !newReminder.case_id || !newReminder.remind_at}
                      style={{ ...s.primaryBtn, opacity: creating || !newReminder.case_id || !newReminder.remind_at ? 0.45 : 1 }}>
                      {creating ? "Creando…" : "Crear recordatorio"}
                    </button>
                    {newReminder.case_id && newReminder.remind_at && (() => {
                      const c = cases.find(cs => cs.id === Number(newReminder.case_id));
                      return (
                        <a href={gcalReminderLink(c?.title ?? "Recordatorio", localToISO(newReminder.remind_at), `${CASE_TYPES.find(t => t.value === c?.case_type)?.label ?? ""}\n${c?.pedimento ? "Pedimento: " + c.pedimento : ""}\nCliente: ${c?.clients?.name ?? ""}`)}
                          target="_blank" rel="noreferrer"
                          style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", background: "#0a1628", border: "1px solid #1e3a6e", borderRadius: 8, color: "#4285f4", fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" as const }}>
                          📅 Agregar a Google Calendar
                        </a>
                      );
                    })()}
                  </div>
                )}
              </section>

              <FilterGroup
                items={[{ id: "all", label: "Todos" }, { id: "pending", label: "⏳ Pendientes" }, { id: "overdue", label: "🔴 Vencidos" }, { id: "sent", label: "✅ Completados" }]}
                active={reminderFilter} onChange={setReminderFilter}
              />

              {filteredReminders.length === 0 ? (
                <div style={s.emptyState}>🔔 No hay recordatorios en esta categoría</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredReminders.map(r => {
                    const rStatus = getReminderStatus(r);
                    const rCfg = REM_CFG[rStatus];
                    const tipo = CASE_TYPES.find(t => t.value === r.cases?.case_type);
                    return (
                      <article key={r.id} style={{ ...s.reminderCard, opacity: r.sent ? 0.65 : 1 }}>
                        {deletingReminderId === r.id ? (
                          <div>
                            <p style={{ margin: 0, color: "#f87171", fontWeight: 600 }}>¿Eliminar este recordatorio?</p>
                            <p style={{ margin: "4px 0 12px", fontSize: 12, color: "#64748b" }}>No se puede deshacer.</p>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => deleteReminder(r.id)} style={s.dangerBtn}>Sí, eliminar</button>
                              <button onClick={() => setDeletingReminderId(null)} style={s.ghostBtn}>Cancelar</button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: rCfg.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🔔</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>{r.cases?.title ?? "Expediente eliminado"}</span>
                                <span style={{ fontSize: 10, fontWeight: 700, background: rCfg.bg, color: rCfg.color, borderRadius: 20, padding: "2px 8px" }}>{rCfg.label}</span>
                                {tipo && <span style={s.tipoPill}>{tipo.icon} {tipo.label}</span>}
                              </div>
                              {r.cases?.pedimento && <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Pedimento: {r.cases.pedimento}</div>}
                              {r.cases?.clients && (
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, fontSize: 12, color: "#64748b", flexWrap: "wrap" }}>
                                  <span>👤 {r.cases.clients.name}</span>
                                  {r.cases.clients.phone && <a href={waLink(r.cases.clients.phone)} target="_blank" rel="noreferrer" style={s.waLink}><span>💬</span><span>{r.cases.clients.phone}</span></a>}
                                </div>
                              )}
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                                <span style={{ color: "#38bdf8", fontSize: 13, fontWeight: 500 }}>{fmtDateTime(r.remind_at)}</span>
                                <span style={{ color: "#334155" }}>·</span>
                                <span style={{ fontSize: 12, color: r.sent ? "#334155" : rStatus === "overdue" ? "#f87171" : "#94a3b8" }}>
                                  {r.sent ? "Completado" : timeUntil(r.remind_at)}
                                </span>
                                {r.retry_count != null && r.retry_count > 0 && !r.sent && (
                                  <span style={{ fontSize: 10, color: "#f97316" }}>⚠️ Intento {r.retry_count}/{3}</span>
                                )}
                              </div>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                              {!r.sent && <button onClick={() => markReminderSent(r.id)} style={s.sentBtn}>✓ Completar</button>}
                              {!r.sent && (
                                <a href={gcalReminderLink(
                                    r.cases?.title ?? "Recordatorio",
                                    r.remind_at,
                                    `${r.cases?.case_type ? CASE_TYPES.find(t => t.value === r.cases?.case_type)?.label ?? "" : ""}\n${r.cases?.pedimento ? "Pedimento: " + r.cases.pedimento : ""}\nCliente: ${r.cases?.clients?.name ?? ""}`
                                  )}
                                  target="_blank" rel="noreferrer"
                                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "5px 8px", background: "#0a1628", border: "1px solid #1e3a6e", borderRadius: 6, color: "#4285f4", fontSize: 11, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" as const }}>
                                  📅 Google Cal
                                </a>
                              )}
                              <button onClick={() => setDeletingReminderId(r.id)} style={s.iconBtn}>🗑️</button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function KPI({ icon, label, value, color, bg, border, sub, onClick }: any) {
  return (
    <div style={{ background: bg, border: `1px solid ${border}33`, borderRadius: 14, padding: "16px 20px", cursor: "pointer", transition: "border-color .15s" }}
      onClick={onClick}
      onMouseEnter={e => (e.currentTarget.style.borderColor = border)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = border + "33")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function DataTag({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: highlight ? "#1a2e0a" : "#0c1525", border: `1px solid ${highlight ? "#365314" : "#152035"}`, borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
      <span style={{ color: "#475569" }}>{label}:</span>
      <span style={{ color: highlight ? "#86efac" : "#94a3b8", fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function FilterGroup({ items, active, onChange }: { items: { id: string; label: string }[]; active: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {items.map(f => (
        <button key={f.id} onClick={() => onChange(f.id)}
          style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid", fontSize: 12, fontWeight: 500, cursor: "pointer", background: active === f.id ? "#2563eb" : "transparent", borderColor: active === f.id ? "#2563eb" : "#1e2d45", color: active === f.id ? "#fff" : "#94a3b8" }}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s: Record<string, any> = {
  root:    { display: "flex", height: "100vh", background: "#060c18", color: "#e2e8f0", fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", overflow: "hidden" },
  toast:   { position: "fixed", top: 20, right: 24, zIndex: 9999, display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 12, border: "1px solid", boxShadow: "0 8px 32px #00000066" },

  sidebar:      { display: "flex", flexDirection: "column", background: "#09111f", borderRight: "1px solid #131f33", transition: "width 0.22s ease", overflow: "hidden", flexShrink: 0 },
  sidebarHeader:{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 12px 16px", borderBottom: "1px solid #131f33" },
  logoName:     { fontWeight: 700, fontSize: 14, color: "#f1f5f9", whiteSpace: "nowrap" },
  logoSub:      { fontSize: 9, color: "#1e4080", whiteSpace: "nowrap", marginTop: 2, letterSpacing: ".3px" },
  collapseBtn:  { background: "#131f33", border: "none", color: "#64748b", width: 24, height: 24, borderRadius: 6, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  nav:          { display: "flex", flexDirection: "column", gap: 2, padding: "12px 8px", flex: 1 },
  navBtn:       { display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 10, border: "none", color: "#64748b", cursor: "pointer", fontSize: 13, fontWeight: 500, background: "transparent", whiteSpace: "nowrap", position: "relative" },
  navBtnActive: { background: "#132244", color: "#e2e8f0" },
  navLabel:     { flex: 1, textAlign: "left" as const },
  badge:        { borderRadius: 20, fontSize: 10, fontWeight: 700, padding: "1px 7px", color: "#fff" },
  sidebarFooter:{ padding: "12px 8px 16px", borderTop: "1px solid #131f33", display: "flex", flexDirection: "column", gap: 8 },
  logoutBtn:    { display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", color: "#475569", padding: "7px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, width: "100%", whiteSpace: "nowrap" },

  main:       { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
  topbar:     { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 28px 14px", borderBottom: "1px solid #131f33", background: "#09111f", flexShrink: 0 },
  pageTitle:  { margin: 0, fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.4px" },
  breadcrumb: { margin: "2px 0 0", fontSize: 11, color: "#1e4080" },
  contentWrap:{ flex: 1, overflowY: "auto" as const, padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 },

  kpiGrid:    { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 },
  dashSection:{ background: "#0c1525", border: "1px solid #152035", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 },
  dashSectionTitle: { fontSize: 12, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: ".5px", marginBottom: 4 },
  dashCaseRow:{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#060c18", borderRadius: 10, borderLeft: "3px solid", cursor: "pointer" },
  typeChip:   { display: "flex", alignItems: "center", gap: 6, background: "#0c1525", border: "1px solid #152035", borderRadius: 20, padding: "5px 12px", fontSize: 12, cursor: "pointer" },

  formCard:     { background: "#0c1525", border: "1px solid #152035", borderRadius: 14, padding: "16px 20px", flexShrink: 0 },
  formCardTitle:{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 13, fontWeight: 600, color: "#475569" },
  formRow:      { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" },
  fieldLabel:   { fontSize: 10, fontWeight: 600, color: "#334155", textTransform: "uppercase" as const, letterSpacing: ".4px" },
  caseTypeInfo: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: "#060c18", border: "1px solid #1a2842", borderRadius: 10, padding: "8px 14px", fontSize: 12 },
  clientPreview:{ display: "flex", alignItems: "center", gap: 10, background: "#060c18", border: "1px solid #1a2842", borderRadius: 10, padding: "8px 14px" },
  emptyHint:    { fontSize: 13, color: "#d97706", background: "#1c1000", border: "1px solid #6b3a00", borderRadius: 10, padding: "10px 14px" },
  linkBtn:      { background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: 13, textDecoration: "underline", padding: 0 },

  caseCard:   { background: "#0c1525", border: "1px solid #152035", borderLeft: "3px solid", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column" },
  caseTitle:  { margin: 0, fontSize: 15, fontWeight: 600, color: "#f1f5f9" },
  statusPill: { border: "none", borderRadius: 20, padding: "3px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", outline: "none" },
  caseDesc:   { margin: "6px 0 0", fontSize: 12, color: "#475569", fontStyle: "italic" },
  urgencyBadge:{ display: "flex", alignItems: "center", gap: 5, border: "1px solid", borderRadius: 20, padding: "3px 10px" },
  tipoPill:   { fontSize: 10, background: "#0f1929", border: "1px solid #1a2842", borderRadius: 20, padding: "2px 8px", color: "#64748b" },
  expandBtn:  { background: "none", border: "none", cursor: "pointer", padding: "8px 0 0", textAlign: "left" as const, width: "100%" },

  actionLog:  { background: "#060c18", borderRadius: 10, overflow: "hidden", border: "1px solid #131f33" },
  actionItem: { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderBottom: "1px solid #0e1929" },
  actionLabel:{ fontSize: 10, fontWeight: 700, color: "#334155", textTransform: "uppercase" as const, letterSpacing: ".5px", display: "block", marginBottom: 2 },
  actionNote: { margin: 0, fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 },
  actionAge:  { fontSize: 11, color: "#1e2d45", whiteSpace: "nowrap" as const, flexShrink: 0 },
  quickRemBtn:{ background: "#1a2e1a", border: "1px solid #166534", color: "#4ade80", borderRadius: 20, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600 },

  clientCard: { background: "#0c1525", border: "1px solid #152035", borderRadius: 14, padding: "16px 18px" },
  reminderCard:{ background: "#0c1525", border: "1px solid #152035", borderRadius: 14, padding: "14px 18px" },

  avatar:     { borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#fff", flexShrink: 0 },
  waLink:     { display: "flex", alignItems: "center", gap: 4, color: "#25d366", fontSize: 12, textDecoration: "none", fontWeight: 500 },
  input:      { background: "#060c18", border: "1px solid #1a2842", color: "#e2e8f0", padding: "8px 12px", borderRadius: 8, fontSize: 13, outline: "none" },
  select:     { background: "#060c18", border: "1px solid #1a2842", color: "#e2e8f0", padding: "8px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer", outline: "none" },
  primaryBtn: { background: "#1d4ed8", color: "#fff", padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  greenBtn:   { background: "#052e16", color: "#4ade80", padding: "8px 14px", borderRadius: 8, border: "1px solid #166534", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  purpleBtn:  { background: "#1e1047", color: "#c4b5fd", padding: "8px 14px", borderRadius: 8, border: "1px solid #4c1d95", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  dangerBtn:  { background: "#450a0a", color: "#fca5a5", padding: "8px 14px", borderRadius: 8, border: "1px solid #991b1b", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  ghostBtn:   { background: "transparent", border: "1px solid #1e2d45", color: "#94a3b8", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  iconBtn:    { background: "transparent", border: "1px solid #152035", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 14, color: "#64748b" },
  sentBtn:    { background: "#052e16", border: "1px solid #166534", color: "#4ade80", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  emptyState: { display: "flex", alignItems: "center", justifyContent: "center", color: "#1e2d45", fontSize: 15, fontWeight: 500, minHeight: 160 },
};
