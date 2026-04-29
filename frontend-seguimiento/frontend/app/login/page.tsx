"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();

  const [mode, setMode]         = useState<"login" | "register">("login");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [msg, setMsg]           = useState<{ text: string; ok: boolean } | null>(null);

  const showMsg = (text: string, ok = true) => setMsg({ text, ok });

  const handleAuth = async () => {
    if (!email || !password) return showMsg("Completa todos los campos", false);
    setLoading(true);
    setMsg(null);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return showMsg(error.message, false);
        router.push("/");
      } else {
        if (!name) return showMsg("Ingresa tu nombre", false);
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: name } },
        });
        if (error) return showMsg(error.message, false);
        if (data.user) showMsg("¡Cuenta creada! Revisa tu correo para confirmar tu registro.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) { showMsg(error.message, false); setLoading(false); }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Logo */}
        <div style={s.logo}>
          <span style={{ fontSize: 32 }}>⚖️</span>
          <div>
            <div style={s.logoName}>LawyerTracker</div>
            <div style={s.logoSub}>Aduana Manzanillo · Puerto 220</div>
          </div>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button onClick={() => { setMode("login"); setMsg(null); }}
            style={{ ...s.tab, ...(mode === "login" ? s.tabActive : {}) }}>
            Iniciar sesión
          </button>
          <button onClick={() => { setMode("register"); setMsg(null); }}
            style={{ ...s.tab, ...(mode === "register" ? s.tabActive : {}) }}>
            Crear cuenta
          </button>
        </div>

        {/* Google */}
        <button onClick={handleGoogle} disabled={loading} style={s.googleBtn}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
            <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
            <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
            <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
          </svg>
          Continuar con Google
        </button>

        <div style={s.divider}><span style={s.dividerText}>o continúa con email</span></div>

        {/* Form */}
        {mode === "register" && (
          <input placeholder="Nombre completo" value={name}
            onChange={e => setName(e.target.value)}
            style={s.input} />
        )}
        <input placeholder="Correo electrónico" type="email" value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAuth()}
          style={s.input} />
        <input placeholder="Contraseña" type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAuth()}
          style={s.input} />

        {msg && (
          <div style={{ ...s.msg, background: msg.ok ? "#052e16" : "#450a0a", borderColor: msg.ok ? "#166534" : "#991b1b", color: msg.ok ? "#4ade80" : "#f87171" }}>
            {msg.text}
          </div>
        )}

        <button onClick={handleAuth} disabled={loading} style={{ ...s.primaryBtn, opacity: loading ? 0.6 : 1 }}>
          {loading ? "…" : mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
        </button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  page:       { minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center", background: "#060d1a" },
  card:       { padding: 36, background: "#0d1829", borderRadius: 16, width: 380, display: "flex", flexDirection: "column", gap: 12, border: "1px solid #1a2842", boxShadow: "0 8px 40px #00000066" },
  logo:       { display: "flex", alignItems: "center", gap: 12, marginBottom: 4 },
  logoName:   { fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" },
  logoSub:    { fontSize: 11, color: "#334155" },
  tabs:       { display: "flex", gap: 0, background: "#060d1a", borderRadius: 8, padding: 3 },
  tab:        { flex: 1, padding: "7px 0", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#475569", borderRadius: 6 },
  tabActive:  { background: "#1a2842", color: "#f1f5f9", fontWeight: 600 },
  googleBtn:  { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "10px 16px", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 8, cursor: "pointer", color: "#e2e8f0", fontSize: 14, fontWeight: 500 },
  divider:    { display: "flex", alignItems: "center", gap: 10 },
  dividerText:{ fontSize: 11, color: "#334155", whiteSpace: "nowrap" as CSSProperties["whiteSpace"], flex: 1, textAlign: "center" as CSSProperties["textAlign"], borderTop: "1px solid #1a2842", paddingTop: 10 },
  input:      { padding: "10px 12px", borderRadius: 8, border: "1px solid #1a2842", background: "#060d1a", color: "#f1f5f9", fontSize: 14, outline: "none" },
  msg:        { padding: "9px 12px", borderRadius: 8, border: "1px solid", fontSize: 13 },
  primaryBtn: { padding: "11px 0", borderRadius: 8, background: "#2563eb", border: "none", cursor: "pointer", color: "white", fontWeight: 700, fontSize: 14 },
};
