
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const MCP_URL =
  "https://questathon.aihackerscollective.com/api/public/mcp";

const DATA_DIR = path.join(__dirname, "../data");
const FILES_DIR = path.join(DATA_DIR, "files");

fs.mkdirSync(FILES_DIR, { recursive: true });

let nextMcpCallAt = 0;

async function callTool(name, args = {}) {
  if (!process.env.AQ_TOKEN) {
    throw new Error("AQ_TOKEN is missing from .env");
  }

  const now = Date.now();
  if (now < nextMcpCallAt) {
    const seconds = Math.ceil((nextMcpCallAt - now) / 1000);
    throw new Error(`One MCP call a minute. Try again in ${seconds}s.`);
  }

  nextMcpCallAt = now + 60_000;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${process.env.AQ_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${raw}`);
  }

  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("MCP returned non-JSON response");
  }

  if (payload.error || payload.result?.isError) {
    throw new Error(
      payload.error?.message ||
      payload.result?.content?.[0]?.text ||
      "MCP tool failed"
    );
  }

  const textContent = payload.result?.content?.find(
    item => item.type === "text"
  )?.text;

  if (!textContent) {
    throw new Error("MCP response did not contain text");
  }

  try {
    return JSON.parse(textContent);
  } catch {
    return textContent;
  }
}

function readJSON(filename) {
  const file = path.join(DATA_DIR, filename);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveData(filename, data) {
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify(data, null, 2)
  );
}

// Dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Local accounts
app.get("/api/accounts", (req, res) => {
  const accounts = readJSON("accounts.json");

  if (!accounts) {
    return res.status(404).json({
      error: "Account data not found",
    });
  }

  res.json(accounts);
});

// Local signals
app.get("/api/signals", (req, res) => {
  const signals = readJSON("signals.json");

  if (!signals) {
    return res.status(404).json({
      error: "Signals have not been fetched",
    });
  }

  res.json(signals);
});

// Fetch fresh signals from MCP
app.post("/api/signals/refresh", async (req, res) => {
  try {
    const signals = await callTool("get_signals");
    saveData("signals.json", signals);

    res.json({
      success: true,
      data: signals,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/notes", (req, res) => {
  res.json(readJSON("notes.json") || { notes: [] });
});

app.post("/api/notes", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const account = req.body?.account ? String(req.body.account) : undefined;
    const kind = req.body?.kind ? String(req.body.kind) : undefined;
    const title = req.body?.title ? String(req.body.title).trim() : undefined;

    if (!text) {
      return res.status(400).json({ error: "Note text is required" });
    }

    const args = { text };
    if (account) args.account = account;
    if (kind) args.kind = kind;
    if (title) args.title = title;

    const result = await callTool("write_note", args);
    const store = readJSON("notes.json") || { notes: [] };

    store.notes.push({
      at: new Date().toISOString(),
      account: account || null,
      kind: kind || "note",
      title: title || "",
      text,
      result
    });

    saveData("notes.json", store);
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read saved evidence files
app.get("/api/evidence/:id", (req, res) => {
  const id = req.params.id;

  const accounts = readJSON("accounts.json");

  const allowed = accounts?.files?.some(
    file => file.id === id
  );

  if (!allowed) {
    return res.status(404).json({
      error: "Unknown evidence file",
    });
  }

  const file = path.join(FILES_DIR, `${id}.txt`);

  if (!fs.existsSync(file)) {
    return res.status(404).json({
      error: "Evidence file not downloaded",
    });
  }

  res.type("text/plain").send(
    fs.readFileSync(file, "utf8")
  );
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`CRM running at http://localhost:${PORT}`);
});
