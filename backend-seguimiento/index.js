require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================
// SUPABASE
// ==========================
const baseSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const getSupabase = (token) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

// ==========================
// AUTH
// ==========================
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing token" });
  const { data: { user }, error } = await baseSupabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  req.token = token;
  next();
};

// ==========================
// HEALTH
// ==========================
app.get("/", (_, res) => res.send("⚖️ LawyerTracker API — OK"));

// ==========================
// CASES — GET
// ==========================
app.get("/cases/full", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { data, error } = await supabase
    .from("cases")
    .select(`
      id, title, description, status, due_date, priority, user_id,
      case_type, pedimento, fraccion_arancelaria, bl_number,
      valor_mercancia, aduana, regimen_aduanero, fecha_notificacion,
      clients (id, name, phone, email),
      actions (id, note, action_type, created_at)
    `)
    .eq("user_id", req.user.id)
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) { console.error("CASES ERROR:", error); return res.status(500).json(error); }
  res.json(data || []);
});

// ==========================
// CASES — CREATE
// ==========================
app.post("/cases", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const {
    title, description, client_id, due_date,
    case_type, pedimento, fraccion_arancelaria, bl_number,
    valor_mercancia, aduana, regimen_aduanero, fecha_notificacion,
  } = req.body;
  const clientId = Number(client_id);
  if (!title || !clientId)
    return res.status(400).json({ error: "title y client_id son requeridos" });

  const { data: client } = await supabase
    .from("clients").select("id").eq("id", clientId).eq("user_id", req.user.id).single();
  if (!client) return res.status(403).json({ error: "Cliente no encontrado" });

  const { data, error } = await supabase
    .from("cases")
    .insert([{
      title,
      description: description || null,
      client_id: clientId,
      due_date: due_date || null,
      user_id: req.user.id,
      status: "pending",
      priority: "medium",
      case_type: case_type || "general",
      pedimento: pedimento || null,
      fraccion_arancelaria: fraccion_arancelaria || null,
      bl_number: bl_number || null,
      valor_mercancia: valor_mercancia ? Number(valor_mercancia) : null,
      aduana: aduana || "220",
      regimen_aduanero: regimen_aduanero || null,
      fecha_notificacion: fecha_notificacion || null,
    }])
    .select().single();
  if (error) { console.error("CREATE CASE ERROR:", error); return res.status(500).json(error); }
  console.log(`📂 Caso #${data.id} creado — ${title} [${case_type || "general"}]`);
  res.json(data);
});

// ==========================
// CASES — UPDATE
// ==========================
app.patch("/cases/:id", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const allowed = [
    "title", "description", "due_date", "case_type",
    "pedimento", "fraccion_arancelaria", "bl_number",
    "valor_mercancia", "aduana", "regimen_aduanero", "fecha_notificacion",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key] || null;
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("cases").update(updates)
    .eq("id", req.params.id).eq("user_id", req.user.id)
    .select().single();
  if (error) { console.error("UPDATE CASE ERROR:", error); return res.status(500).json(error); }
  res.json(data);
});

// ==========================
// CASES — DELETE
// ==========================
app.delete("/cases/:id", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const caseId = Number(req.params.id);
  await supabase.from("reminders").delete().eq("case_id", caseId);
  await supabase.from("actions").delete().eq("case_id", caseId);
  const { error } = await supabase.from("cases").delete().eq("id", caseId).eq("user_id", req.user.id);
  if (error) { console.error("DELETE CASE ERROR:", error); return res.status(500).json(error); }
  console.log(`🗑️ Expediente #${caseId} eliminado`);
  res.json({ ok: true });
});

// ==========================
// CASES — UPDATE STATUS
// ==========================
const VALID_STATUSES = ["pending", "active", "closed"];

app.patch("/cases/:id/status", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: "Status inválido" });
  const { data, error } = await supabase
    .from("cases")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", req.params.id).eq("user_id", req.user.id)
    .select().single();
  if (error) { console.error("STATUS ERROR:", error); return res.status(500).json(error); }
  res.json(data);
});

// ==========================
// CASES — CLOSE (cierre formal)
// ==========================
app.post("/cases/:id/close", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const caseId = Number(req.params.id);
  const { resultado, nota } = req.body;

  const RESULTADOS = ["favorable","desfavorable","sobreseido","desistido","acuerdo","prescrito","sin_resolucion"];
  if (!resultado || !RESULTADOS.includes(resultado))
    return res.status(400).json({ error: "resultado inválido" });

  const { error: caseErr } = await supabase
    .from("cases")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", caseId).eq("user_id", req.user.id);
  if (caseErr) { console.error("CLOSE CASE ERROR:", caseErr); return res.status(500).json(caseErr); }

  const RESULTADO_LABELS = {
    favorable: "Favorable al cliente", desfavorable: "Desfavorable",
    sobreseido: "Sobreseído", desistido: "Desistido / Retirado",
    acuerdo: "Acuerdo / Convenio", prescrito: "Prescrito / Caducado",
    sin_resolucion: "Sin resolución formal",
  };
  const noteText = nota?.trim()
    ? `[Expediente cerrado — ${RESULTADO_LABELS[resultado]}] ${nota.trim()}`
    : `Expediente cerrado — ${RESULTADO_LABELS[resultado]}`;

  await supabase.from("actions").insert([{
    case_id: caseId, note: noteText,
    action_type: "resolucion", user_id: req.user.id,
  }]);
  await supabase.from("reminders").update({ sent: true }).eq("case_id", caseId).eq("sent", false);

  console.log(`✅ Expediente #${caseId} cerrado — ${RESULTADO_LABELS[resultado]}`);
  res.json({ ok: true });
});

// ==========================
// ACTIONS — CREATE
// ==========================
app.post("/actions", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { case_id, note, action_type } = req.body;
  const caseId = Number(case_id);
  if (!caseId || !note)
    return res.status(400).json({ error: "case_id y note son requeridos" });
  const { data, error } = await supabase
    .from("actions")
    .insert([{ case_id: caseId, note, action_type: action_type || "nota", user_id: req.user.id }])
    .select();
  if (error) { console.error("ACTION ERROR:", error); return res.status(500).json(error); }
  res.json(data);
});

// ==========================
// CLIENTS — GET
// ==========================
app.get("/clients", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { data, error } = await supabase
    .from("clients")
    .select(`id, name, phone, email, created_at, cases (id, title, status, case_type)`)
    .eq("user_id", req.user.id)
    .order("name", { ascending: true });
  if (error) { console.error("CLIENTS ERROR:", error); return res.status(500).json(error); }
  res.json(data || []);
});

// ==========================
// CLIENTS — CREATE
// ==========================
app.post("/clients", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const { data, error } = await supabase
    .from("clients")
    .insert([{ name, phone: phone || null, email: email || null, user_id: req.user.id }])
    .select().single();
  if (error) { console.error("CREATE CLIENT ERROR:", error); return res.status(500).json(error); }
  res.json(data);
});

// ==========================
// CLIENTS — UPDATE
// ==========================
app.patch("/clients/:id", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const { data, error } = await supabase
    .from("clients")
    .update({ name, phone: phone || null, email: email || null })
    .eq("id", req.params.id).eq("user_id", req.user.id)
    .select().single();
  if (error) return res.status(500).json(error);
  res.json(data);
});

// ==========================
// CLIENTS — DELETE
// ==========================
app.delete("/clients/:id", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { error } = await supabase
    .from("clients").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  if (error) return res.status(500).json(error);
  res.json({ ok: true });
});

// ==========================
// REMINDERS — GET
// ==========================
app.get("/reminders", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  try {
    const { data: reminders, error } = await supabase
      .from("reminders")
      .select("id, case_id, remind_at, sent, created_at, retry_count")
      .eq("user_id", req.user.id)
      .order("remind_at", { ascending: true });
    if (error) throw error;
    if (!reminders.length) return res.json([]);

    const caseIds = [...new Set(reminders.map(r => r.case_id))];
    const { data: cases } = await supabase
      .from("cases")
      .select("id, title, client_id, case_type, pedimento")
      .in("id", caseIds);

    const clientIds = [...new Set((cases || []).map(c => c.client_id))];
    const { data: clients } = await supabase
      .from("clients").select("id, name, phone").in("id", clientIds);

    const result = reminders.map(r => {
      const cs = (cases || []).find(c => c.id === r.case_id);
      const cl = (clients || []).find(c => c.id === cs?.client_id);
      return {
        ...r,
        cases: {
          id: cs?.id, title: cs?.title, case_type: cs?.case_type, pedimento: cs?.pedimento,
          clients: cl ? { name: cl.name, phone: cl.phone } : null,
        },
      };
    });
    res.json(result);
  } catch (err) {
    console.error("REMINDERS GET ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// REMINDERS — CREATE
// ==========================
app.post("/reminders", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { case_id, remind_at } = req.body;
  const caseId = Number(case_id);
  if (!caseId || !remind_at)
    return res.status(400).json({ error: "case_id y remind_at son requeridos" });

  const { data: caseData } = await supabase
    .from("cases").select("id").eq("id", caseId).eq("user_id", req.user.id).single();
  if (!caseData) return res.status(403).json({ error: "Caso no encontrado" });

  const { data, error } = await supabase
    .from("reminders")
    .insert([{ case_id: caseId, remind_at, user_id: req.user.id, sent: false, retry_count: 0 }])
    .select().single();
  if (error) { console.error("CREATE REMINDER ERROR:", error); return res.status(500).json(error); }
  console.log(`📅 Recordatorio #${data.id} creado`);
  res.json(data);
});

// ==========================
// REMINDERS — MARK SENT
// ==========================
app.patch("/reminders/:id/sent", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { data, error } = await supabase
    .from("reminders").update({ sent: true }).eq("id", req.params.id).eq("user_id", req.user.id)
    .select().single();
  if (error) return res.status(500).json(error);
  res.json(data);
});

// ==========================
// REMINDERS — DELETE
// ==========================
app.delete("/reminders/:id", auth, async (req, res) => {
  const supabase = getSupabase(req.token);
  const { error } = await supabase
    .from("reminders").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  if (error) return res.status(500).json(error);
  res.json({ ok: true });
});

// ==========================
// SERVER
// ==========================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 LawyerTracker API en puerto ${PORT}`));
