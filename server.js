import "dotenv/config";
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } from "docx";
import { GoogleGenAI, Type } from "@google/genai";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { google } from "googleapis";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json({ limit: "5mb" }));
// ---------- Admin auth (HTTP Basic: any username, password = ADMIN_PASSWORD) ----------
const sha = x => crypto.createHash("sha256").update(String(x)).digest();
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).send("Set ADMIN_PASSWORD in .env to enable the admin panel, then restart.");
  const decoded = Buffer.from((req.headers.authorization || "").split(" ")[1] || "", "base64").toString();
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  if (decoded.includes(":") && crypto.timingSafeEqual(sha(pass), sha(process.env.ADMIN_PASSWORD))) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Quiz Admin"');
  res.status(401).send("Authentication required.");
}
app.use(["/admin", "/admin.html", "/api/admin"], adminAuth);

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));

const AUDIO = { mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/aac", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", aiff: "audio/aiff", webm: "audio/ogg" };

// ---------- Question types ----------
// single = MCQ with one correct answer, multi = MCQ with several correct answers, tf = True/False
const TYPES = ["single", "multi", "tf"];
const TF_LABELS = { English: ["True", "False"], "Roman Urdu": ["Sahi", "Ghalat"] };
const qType = q => (TYPES.includes(q?.type) ? q.type : "single");
const correctOf = q => (Array.isArray(q.answers) ? q.answers : [q.answer]).filter(Number.isInteger).sort((a, b) => a - b);
const asArr = p => (p == null ? [] : Array.isArray(p) ? p : [p]);
const isRight = (q, p) => {
  const c = correctOf(q), a = [...new Set(asArr(p))].sort((x, y) => x - y);
  return a.length === c.length && a.every((v, i) => v === c[i]);
};
function typeRule(type, lang) {
  const [t, f] = TF_LABELS[lang];
  if (type === "multi") return `Each question is a MULTI-SELECT multiple-choice question ("select all that apply") with exactly 4 options. Between 2 and 3 options are correct (vary this), and at least one is wrong. "answers" is the array of 0-based indices of ALL correct options.`;
  if (type === "tf") return `Each item is a TRUE/FALSE statement. "q" is a clear statement (not a question) that is either true or false according to the material; make roughly half of them true and half false. "options" must be exactly ["${t}", "${f}"]. "answers" is [0] if the statement is true or [1] if it is false.`;
  return `Each question is a SINGLE-SELECT multiple-choice question with exactly 4 options and exactly one correct answer. "answers" is an array holding the single 0-based index of the correct option.`;
}
function normalize(q, type, lang) {
  if (!q || typeof q.q !== "string" || !q.q.trim()) return null;
  let options = Array.isArray(q.options) ? q.options.map(String) : [];
  let answers = [...new Set((Array.isArray(q.answers) ? q.answers : [q.answer]).filter(Number.isInteger))].sort((a, b) => a - b);
  if (type === "tf") { options = TF_LABELS[lang]; answers = answers.slice(0, 1); }
  else if (options.length < 2) return null;
  answers = answers.filter(k => k >= 0 && k < options.length);
  if (type !== "multi") answers = answers.slice(0, 1);
  if (!answers.length) return null;
  return { q: q.q, type, options, answer: answers[0], answers, explanation: q.explanation || "" };
}

const schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          q: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          answers: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          explanation: { type: Type.STRING },
        },
        required: ["q", "options", "answers", "explanation"],
      },
    },
  },
  required: ["title", "questions"],
};

app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const n = Math.max(1, Math.min(50, parseInt(req.body.n) || 10));
    const lang = req.body.lang === "Roman Urdu" ? "Roman Urdu" : "English";
    const type = TYPES.includes(req.body.type) ? req.body.type : "single";
    const f = req.file;
    if (!f) return res.status(400).json({ error: "No file uploaded." });

    const ext = f.originalname.split(".").pop().toLowerCase();
    const parts = [];
    if (ext === "pdf") {
      parts.push({ inlineData: { mimeType: "application/pdf", data: f.buffer.toString("base64") } });
    } else if (ext === "docx") {
      const { value } = await mammoth.extractRawText({ buffer: f.buffer });
      if (value.trim().length < 50) return res.status(400).json({ error: "The document has too little text." });
      parts.push({ text: "SOURCE TEXT:\n" + value.slice(0, 400000) });
    } else if (AUDIO[ext] || (f.mimetype || "").startsWith("audio/")) {
      parts.push({ inlineData: { mimeType: AUDIO[ext] || f.mimetype, data: f.buffer.toString("base64") } });
    } else {
      return res.status(400).json({ error: "Unsupported file type. Use PDF, DOCX or audio." });
    }

    const langRule = lang === "Roman Urdu"
      ? 'Write everything in Roman Urdu (Urdu written in the Latin alphabet, e.g. "Pakistan ka darulhukumat kaun sa hai?"). Use Latin characters only.'
      : "Write everything in English.";
    const what = type === "tf" ? "true/false quiz" : type === "multi" ? "multiple-choice quiz with multiple correct answers per question" : "multiple-choice quiz";
    parts.push({ text: `Create a ${what} based only on the provided material (document, PDF or audio recording).
Exactly ${n} questions. ${typeRule(type, lang)} ${langRule}
"explanation" is one short sentence. Vary difficulty and avoid trivial questions.` });

    const r = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 },
    });
    const quiz = JSON.parse(r.text);
    quiz.questions = quiz.questions.map(q => normalize(q, type, lang)).filter(Boolean).slice(0, n);
    quiz.lang = lang;
    quiz.type = type;
    res.json(quiz);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Generation failed." });
  }
});

const L = "ABCDEF";
const keyLine = (q, i) => `${i + 1}. ${correctOf(q).map(k => L[k] ?? "?").join(", ") || "?"}${q.explanation ? " — " + q.explanation : ""}`;
const fname = t => (t || "quiz").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "quiz";

app.post("/api/export/pdf", (req, res) => {
  const { quiz, includeKey } = req.body;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fname(quiz.title)}.pdf"`);
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);
  doc.font("Helvetica-Bold").fontSize(20).text(quiz.title).moveDown(0.3);
  doc.font("Helvetica").fontSize(10).text(`Language: ${quiz.lang}   |   Name: ____________________   Date: ____________`).moveDown(1);
  quiz.questions.forEach((q, i) => {
    doc.font("Helvetica-Bold").fontSize(12).text(`${i + 1}. ${q.q}`).moveDown(0.2);
    if (qType(q) === "multi") doc.font("Helvetica-Oblique").fontSize(10).text("(Select all that apply)", { indent: 18 }).moveDown(0.1);
    doc.font("Helvetica").fontSize(11);
    q.options.forEach((o, k) => doc.text(`${L[k]}. ${o}`, { indent: 18 }));
    doc.moveDown(0.8);
  });
  if (includeKey) {
    doc.addPage().font("Helvetica-Bold").fontSize(16).text("Answer Key").moveDown(0.5);
    doc.font("Helvetica").fontSize(11);
    quiz.questions.forEach((q, i) => doc.text(keyLine(q, i)).moveDown(0.2));
  }
  doc.end();
});

app.post("/api/export/docx", async (req, res) => {
  const { quiz, includeKey } = req.body;
  const P = (t, o = {}) => new Paragraph({
    spacing: { after: o.after ?? 80 }, indent: o.indent ? { left: o.indent } : undefined,
    children: [new TextRun({ text: t, bold: o.bold, size: o.size || 24 })],
  });
  const ch = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(quiz.title)] }),
    P(`Language: ${quiz.lang}   |   Name: ____________________   Date: ____________`, { size: 20, after: 240 }),
  ];
  quiz.questions.forEach((q, i) => {
    ch.push(P(`${i + 1}. ${q.q}`, { bold: true, after: 60 }));
    if (qType(q) === "multi") ch.push(P("(Select all that apply)", { size: 20, indent: 360, after: 40 }));
    q.options.forEach((o, k) => ch.push(P(`${L[k]}. ${o}`, { indent: 360, after: 40 })));
    ch.push(P("", { after: 120 }));
  });
  if (includeKey) {
    ch.push(new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Answer Key")] }));
    quiz.questions.forEach((q, i) => ch.push(P(keyLine(q, i))));
  }
  const buf = await Packer.toBuffer(new Document({ sections: [{ children: ch }] }));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${fname(quiz.title)}.docx"`);
  res.send(buf);
});

// ---------- Google Sheets ----------
const DATA = path.join(__dirname, "data");
const CFG = path.join(DATA, "config.json");
const CRED = path.join(DATA, "service-account.json");
const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const writeJSON = (p, o) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 }); };
const FIXED = ["Timestamp", "Name", "Email", "Score"];
const headerFor = n => [...FIXED, ...Array.from({ length: n }, (_, i) => [`Question ${i + 1}`, `Answer ${i + 1}`]).flat()];
const qn = n => `'${n.replace(/'/g, "''")}'`;
const parseId = s => { const m = String(s).match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : String(s).trim(); };
const validTab = n => n && n.length <= 100 && !/[\[\]*?:\/\\]/.test(n);

function sheetsClient() {
  const credentials = readJSON(CRED);
  if (!credentials) throw new Error("Service account JSON has not been saved yet.");
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth });
}
function friendly(e) {
  const code = e.code || e.status;
  if (code === 403) return "Permission denied. Share the Google Sheet with the service account email (Editor access) and make sure the Google Sheets API is enabled.";
  if (code === 404) return "Spreadsheet not found. Check the URL / ID.";
  return e.message || "Google Sheets error.";
}
async function ensureSheet(sheets, id, name, nQ = 1) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties(sheetId,title,gridProperties.columnCount)" });
  let tab = meta.data.sheets.find(s => s.properties.title === name);
  let created = false;
  if (!tab) {
    const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: name } } }] } });
    tab = { properties: r.data.replies[0].addSheet.properties }; created = true;
  }
  // make sure the tab has enough columns (new tabs only have 26)
  const need = FIXED.length + 2 * nQ, cols = tab.properties.gridProperties?.columnCount || 26;
  if (cols < need)
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: "COLUMNS", length: need - cols } }] } });
  // header row: Timestamp, Name, Email, Score, Question 1, Answer 1, Question 2, Answer 2, ...
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${qn(name)}!1:1` });
  const row = r.data.values?.[0] || [];
  if (row.length && FIXED.some((h, i) => row[i] !== h))
    throw new Error(`The tab “${name}” already has a different layout. Use a new sheet name in the admin panel.`);
  const have = row.length ? Math.floor((row.length - FIXED.length) / 2) : 0;
  if (!row.length || have < nQ)
    await sheets.spreadsheets.values.update({ spreadsheetId: id, range: `${qn(name)}!A1`, valueInputOption: "RAW", requestBody: { values: [headerFor(Math.max(nQ, have))] } });
  return created;
}

app.get("/api/admin/status", (req, res) => {
  const cred = readJSON(CRED), cfg = readJSON(CFG) || {};
  res.json({ hasCredentials: !!cred, clientEmail: cred?.client_email || null, spreadsheetId: cfg.spreadsheetId || "", sheetName: cfg.sheetName || "", connected: !!cfg.connected });
});
app.post("/api/admin/credentials", (req, res) => {
  try {
    const c = typeof req.body.json === "string" ? JSON.parse(req.body.json) : req.body.json;
    if (!c?.client_email || !c?.private_key) throw new Error("Not a valid service account key (missing client_email / private_key).");
    writeJSON(CRED, c);
    const cfg = readJSON(CFG) || {}; cfg.connected = false; writeJSON(CFG, cfg);
    res.json({ ok: true, clientEmail: c.client_email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/admin/connect", async (req, res) => {
  try {
    const spreadsheetId = parseId(req.body.spreadsheet || "");
    const sheetName = String(req.body.sheetName || "").trim();
    if (!spreadsheetId) throw new Error("Enter the spreadsheet URL or ID.");
    if (!validTab(sheetName)) throw new Error("Sheet name is required (max 100 chars, cannot contain [ ] * ? : / \\).");
    const created = await ensureSheet(sheetsClient(), spreadsheetId, sheetName);
    writeJSON(CFG, { spreadsheetId, sheetName, connected: true });
    res.json({ ok: true, created, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  } catch (e) { console.error(e); res.status(400).json({ error: friendly(e) }); }
});
app.post("/api/admin/disconnect", (req, res) => {
  const cfg = readJSON(CFG) || {}; cfg.connected = false; writeJSON(CFG, cfg); res.json({ ok: true });
});

app.post("/api/admin/test", async (req, res) => {
  const steps = [];
  const add = (step, ok, detail, warn = false) => steps.push({ step, ok, detail, warn });
  const done = () => res.json({ ok: steps.every(s => s.ok), steps });
  try {
    const cfg = readJSON(CFG) || {};
    const cred = readJSON(CRED);
    const spreadsheetId = parseId(req.body.spreadsheet || cfg.spreadsheetId || "");
    const sheetName = String(req.body.sheetName || cfg.sheetName || "").trim();

    if (!cred) { add("Service account key", false, "No key saved yet. Paste and save the JSON key first."); return done(); }
    add("Service account key", true, cred.client_email);

    const auth = new google.auth.GoogleAuth({ credentials: cred, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    try {
      const t = await (await auth.getClient()).getAccessToken();
      if (!t?.token) throw new Error("No access token returned.");
      add("Authentication", true, "Google accepted the key.");
    } catch (e) { add("Authentication", false, "Google rejected the key: " + (e.message || "unknown error")); return done(); }

    if (!spreadsheetId) { add("Spreadsheet access", false, "Enter the spreadsheet URL or ID."); return done(); }
    const sheets = google.sheets({ version: "v4", auth });
    let meta;
    try {
      meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties(sheetId,title)" });
      add("Spreadsheet access", true, `Opened “${meta.data.properties.title}”.`);
    } catch (e) { add("Spreadsheet access", false, friendly(e)); return done(); }

    const tab = sheetName ? meta.data.sheets.find(s => s.properties.title === sheetName) : null;
    if (!sheetName) add("Sheet tab", false, "Enter the sheet (tab) name.");
    else if (tab) add("Sheet tab", true, `Tab “${sheetName}” exists.`);
    else add("Sheet tab", true, `Tab “${sheetName}” doesn't exist yet. It will be created when you press Connect.`, true);

    // Non-destructive write check: re-save a tab's own title (needs Editor access, changes nothing)
    const target = (tab || meta.data.sheets[0]).properties;
    try {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
        { updateSheetProperties: { properties: { sheetId: target.sheetId, title: target.title }, fields: "title" } }] } });
      add("Write permission", true, "The service account can edit this spreadsheet.");
    } catch (e) { add("Write permission", false, "Cannot edit the spreadsheet. Share it with the service account as Editor (not Viewer). " + (e.message || "")); }
    done();
  } catch (e) { console.error(e); add("Unexpected error", false, e.message || String(e)); done(); }
});

// Called by the quiz page when a participant submits
app.post("/api/submit", async (req, res) => {
  try {
    const cfg = readJSON(CFG);
    if (!cfg?.connected) return res.json({ saved: false, reason: "Google Sheets is not connected." });
    const { name, email, quiz, picked } = req.body;
    if (!name || !email || !Array.isArray(quiz?.questions) || !Array.isArray(picked)) return res.status(400).json({ saved: false, reason: "Bad submission." });
    const total = quiz.questions.length;
    const score = quiz.questions.reduce((n, q, i) => n + (isRight(q, picked[i]) ? 1 : 0), 0);
    const clip = v => String(v ?? "").slice(0, 2000);
    const row = [new Date().toISOString(), clip(name), clip(email), `${score}/${total}`];
    quiz.questions.forEach((q, i) => {
      const p = asArr(picked[i]).filter(k => Number.isInteger(k) && q.options?.[k] != null);
      row.push(clip(q.q), p.length ? clip(p.map(k => `${L[k]}. ${q.options[k]}`).join("; ")) : "(not answered)");
    });
    const sheets = sheetsClient();
    await ensureSheet(sheets, cfg.spreadsheetId, cfg.sheetName, total);
    await sheets.spreadsheets.values.append({ spreadsheetId: cfg.spreadsheetId, range: `${qn(cfg.sheetName)}!A1`,
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] } });
    res.json({ saved: true });
  } catch (e) { console.error(e); res.status(500).json({ saved: false, reason: friendly(e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz Generator running at http://localhost:${PORT}  (model: ${MODEL})`));
