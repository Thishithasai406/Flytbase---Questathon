
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

// ---------------- MCP HELPER ----------------

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
      params: {
        name,
        arguments: args,
      },
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

// ---------------- FILE HELPERS ----------------

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

// ---------------- DASHBOARD DATA ----------------

function getDashboardData() {
  const base = readJSON("accounts.json");

  if (!base) {
    throw new Error("Account data not found");
  }

  const result = {
    ...base,
    accounts: [...(base.accounts || [])],
    files: [...(base.files || [])],
  };

  // Load Kestrel Estates export
  const kExport = readJSON("account_K.json");

  if (kExport) {
    const kAccount = (kExport.accounts || []).find(
      account => String(account.id) === "K"
    );

    if (kAccount) {
      // Prevent duplicate K entries
      result.accounts = result.accounts.filter(
        account => String(account.id) !== "K"
      );

      result.accounts.push({
        ...kAccount,
        id: "K",
      });
    }

    // Merge K evidence file metadata
    const kFiles = (kExport.files || []).map(file => ({
      ...file,
      account: "K",
      title: file.title || file.name || file.id,
    }));

    const existingFileIds = new Set(
      result.files.map(file => file.id)
    );

    for (const file of kFiles) {
      if (file.id && !existingFileIds.has(file.id)) {
        result.files.push(file);
        existingFileIds.add(file.id);
      }
    }
  }

  return result;
}

// ---------------- DASHBOARD ----------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ---------------- HEALTH ----------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "FlytBase CRM server is running",
  });
});

// ---------------- MCP TOOL DISCOVERY ----------------

app.get("/api/mcp/tools", async (req, res) => {
  try {
    if (!process.env.AQ_TOKEN) {
      throw new Error("AQ_TOKEN is missing from .env");
    }

    const now = Date.now();

    if (now < nextMcpCallAt) {
      const seconds = Math.ceil((nextMcpCallAt - now) / 1000);

      return res.status(429).json({
        error: `Wait ${seconds}s before the next MCP call`,
      });
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
        method: "tools/list",
        params: {},
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${raw}`);
    }

    const payload = JSON.parse(raw);

    if (payload.error) {
      throw new Error(payload.error.message);
    }

    res.json({
      tools: (payload.result?.tools || []).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// ---------------- FETCH LIVE ACCOUNTS ----------------

app.post("/api/mcp/accounts", async (req, res) => {
  try {
    const result = await callTool("get_my_accounts");

    saveData("accounts_live.json", result);

    res.json({
      success: true,
      source: "Questathon MCP",
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- MCP IDENTITY ----------------

app.post("/api/mcp/whoami", async (req, res) => {
  try {
    const result = await callTool("whoami");

    saveData("whoami.json", result);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- FETCH THIRD ACCOUNT ----------------

app.post("/api/mcp/new-account", async (req, res) => {
  try {
    const account = String(req.body?.account || "").trim();

    if (account !== "K") {
      return res.status(400).json({
        success: false,
        error: "Invalid account. Expected K.",
      });
    }

    const result = await callTool("get_new_account", {
      account,
    });

    saveData("account_K.json", result);

    res.json({
      success: true,
      account,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- LOCAL ACCOUNTS ----------------

app.get("/api/accounts", (req, res) => {
  try {
    const accounts = getDashboardData();
    res.json(accounts);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// ---------------- LOCAL SIGNALS ----------------

app.get("/api/signals", (req, res) => {
  const signals = readJSON("signals.json");

  if (!signals) {
    return res.status(404).json({
      error: "Signals have not been fetched",
    });
  }

  res.json(signals);
});

// ---------------- REFRESH SIGNALS ----------------

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

// ---------------- NOTES ----------------

app.get("/api/notes", (req, res) => {
  res.json(readJSON("notes.json") || {
    notes: [],
  });
});

app.post("/api/notes", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();

    const account = req.body?.account
      ? String(req.body.account)
      : undefined;

    const kind = req.body?.kind
      ? String(req.body.kind)
      : undefined;

    const title = req.body?.title
      ? String(req.body.title).trim()
      : undefined;

    if (!text) {
      return res.status(400).json({
        error: "Note text is required",
      });
    }

    const args = { text };

    if (account) args.account = account;
    if (kind) args.kind = kind;
    if (title) args.title = title;

    const result = await callTool("write_note", args);

    const store = readJSON("notes.json") || {
      notes: [],
    };

    store.notes.push({
      at: new Date().toISOString(),
      account: account || null,
      kind: kind || "note",
      title: title || "",
      text,
      result,
    });

    saveData("notes.json", store);

    res.json({
      success: true,
      data: store,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- EVIDENCE FILES ----------------

app.get("/api/evidence/:id", (req, res) => {
  const id = req.params.id;

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      error: "Invalid evidence file ID",
    });
  }

  let dashboardData;

  try {
    dashboardData = getDashboardData();
  } catch (error) {
    return res.status(500).json({
      error: error.message,
    });
  }

  const allowed = dashboardData.files.some(
    file => file.id === id
  );

  if (!allowed) {
    return res.status(404).json({
      error: "Unknown evidence file",
    });
  }

  const filePath = path.join(FILES_DIR, `${id}.txt`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: `Evidence file ${id} has not been downloaded yet`,
    });
  }

  res.type("text/plain").send(
    fs.readFileSync(filePath, "utf8")
  );
});

// ---------------- START SERVER ----------------

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`CRM running at http://localhost:${PORT}`);
});
