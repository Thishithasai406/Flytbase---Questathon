
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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

// One MCP call per minute per token.
let nextMcpCallAt = 0;

let pendingAccountIds = [];
let pendingEvidenceFiles = [];
let autoDiscoveryBusy = false;

// ---------------- MCP HELPER ----------------

async function callTool(name, args = {}) {
  if (!process.env.AQ_TOKEN) {
    throw new Error("AQ_TOKEN is missing from .env");
  }

  const now = Date.now();

  if (now < nextMcpCallAt) {
    const seconds = Math.ceil(
      (nextMcpCallAt - now) / 1000
    );

    throw new Error(
      `One MCP call a minute. Try again in ${seconds}s.`
    );
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

function isValidAccountId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ""));
}

function isValidFileId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ""));
}

// ---------------- ACCOUNT HELPERS ----------------

function getSavedAdditionalAccountIds() {
  const savedIds = new Set();

  const filenames = fs.readdirSync(DATA_DIR).filter(file =>
    /^account_[A-Za-z0-9_-]+\.json$/.test(file)
  );

  for (const filename of filenames) {
    try {
      const accountExport = readJSON(filename);

      for (const account of accountExport?.accounts || []) {
        if (account?.id) {
          savedIds.add(String(account.id));
        }
      }
    } catch (error) {
      console.error(
        `[ACCOUNT] Could not read ${filename}:`,
        error.message
      );
    }
  }

  return savedIds;
}

function queueNewAccounts(identity) {
  const newAccounts = identity?.new_accounts || [];

  if (!Array.isArray(newAccounts)) {
    return 0;
  }

  const savedIds = getSavedAdditionalAccountIds();
  let added = 0;

  for (const item of newAccounts) {
    const accountId = String(item?.id || "").trim();

    if (!isValidAccountId(accountId)) continue;
    if (savedIds.has(accountId)) continue;
    if (pendingAccountIds.includes(accountId)) continue;

    pendingAccountIds.push(accountId);
    added++;
  }

  return added;
}

// ---------------- EVIDENCE QUEUE ----------------

function getEvidenceQueueKey(account, fileId) {
  return `${account}:${fileId}`;
}

function queueEvidenceFiles(accountExport, accountId) {
  const files = accountExport?.files || [];

  if (!Array.isArray(files)) {
    return 0;
  }

  let added = 0;

  for (const file of files) {
    const fileId = String(file?.id || "").trim();

    if (!isValidFileId(fileId)) continue;

    const filePath = path.join(FILES_DIR, `${fileId}.txt`);

    // Already downloaded.
    if (fs.existsSync(filePath)) continue;

    const alreadyQueued = pendingEvidenceFiles.some(
      item =>
        getEvidenceQueueKey(item.account, item.fileId) ===
        getEvidenceQueueKey(accountId, fileId)
    );

    if (alreadyQueued) continue;

    pendingEvidenceFiles.push({
      account: accountId,
      fileId,
    });

    added++;
  }

  return added;
}

// Queue missing evidence files from accounts already saved.
// This also handles H and K, which were fetched before this update.
function queueMissingEvidenceFiles() {
  const filenames = fs.readdirSync(DATA_DIR).filter(file =>
    /^account_[A-Za-z0-9_-]+\.json$/.test(file)
  );

  let added = 0;

  for (const filename of filenames) {
    try {
      const accountExport = readJSON(filename);

      const accountId = filename
        .replace(/^account_/, "")
        .replace(/\.json$/, "");

      added += queueEvidenceFiles(
        accountExport,
        accountId
      );

    } catch (error) {
      console.error(
        `[EVIDENCE] Could not inspect ${filename}:`,
        error.message
      );
    }
  }

  return added;
}

// Extract actual file text from the MCP response.
function extractEvidenceText(result) {
  if (typeof result === "string") {
    return result;
  }

  if (!result || typeof result !== "object") {
    throw new Error("Evidence response is empty");
  }

  if (typeof result.text === "string") {
    return result.text;
  }

  if (typeof result.content === "string") {
    return result.content;
  }

  if (typeof result.data === "string") {
    return result.data;
  }

  if (result.file && typeof result.file.text === "string") {
    return result.file.text;
  }

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .filter(item => item && typeof item.text === "string")
      .map(item => item.text);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  if (result.data && typeof result.data === "object") {
    return extractEvidenceText(result.data);
  }

  throw new Error(
    `Could not identify evidence text in MCP response. Returned fields: ${Object.keys(result).join(", ")}`
  );
}

// ---------------- DASHBOARD DATA ----------------

function getDashboardData() {
  const live = readJSON("accounts_live.json");
  const base = live || readJSON("accounts.json");

  if (!base) {
    throw new Error("Account data not found");
  }

  const result = {
    ...base,
    accounts: [...(base.accounts || [])],
    files: [...(base.files || [])],
  };

  // Load all saved additional account exports.
  const accountFiles = fs.readdirSync(DATA_DIR).filter(file =>
    /^account_[A-Za-z0-9_-]+\.json$/.test(file)
  );

  for (const filename of accountFiles) {
    try {
      const accountExport = readJSON(filename);

      if (!accountExport) continue;

      for (const accountData of accountExport.accounts || []) {
        if (!accountData?.id) continue;

        const accountId = String(accountData.id);

        result.accounts = result.accounts.filter(
          account => String(account.id) !== accountId
        );

        result.accounts.push(accountData);
      }

      const accountId = filename
        .replace(/^account_/, "")
        .replace(/\.json$/, "");

      const accountFilesData = (
        accountExport.files || []
      ).map(file => ({
        ...file,
        account: accountId,
        title: file.title || file.name || file.id,
      }));

      const existingFileIds = new Set(
        result.files.map(file => file.id)
      );

      for (const file of accountFilesData) {
        if (file.id && !existingFileIds.has(file.id)) {
          result.files.push(file);
          existingFileIds.add(file.id);
        }
      }

    } catch (error) {
      console.error(
        `[DASHBOARD] Could not load ${filename}:`,
        error.message
      );
    }
  }

  return result;
}

// ---------------- AUTOMATIC DISCOVERY ----------------

async function runAutoDiscovery() {
  if (autoDiscoveryBusy || !process.env.AQ_TOKEN) {
    return;
  }

  autoDiscoveryBusy = true;

  try {
    // 1. Fetch an account first if one is waiting.
    if (pendingAccountIds.length > 0) {
      const accountId = pendingAccountIds.shift();

      try {
        console.log(
          `[AUTO] Fetching account ${accountId}`
        );

        const result = await callTool("get_new_account", {
          account: accountId,
        });

        const matchingAccount = (
          result?.accounts || []
        ).find(
          account => String(account?.id) === accountId
        );

        if (!matchingAccount) {
          throw new Error(
            `Account ${accountId} missing from MCP export`
          );
        }

        saveData(`account_${accountId}.json`, result);

        const queuedFiles = queueEvidenceFiles(
          result,
          accountId
        );

        console.log(
          `[AUTO] Account ${accountId} saved. ${queuedFiles} evidence file(s) queued.`
        );

      } catch (error) {
        pendingAccountIds.unshift(accountId);

        console.error(
          `[AUTO] Account ${accountId} failed:`,
          error.message
        );
      }

      return;
    }

    // 2. Download one pending evidence file.
    if (pendingEvidenceFiles.length > 0) {
      const task = pendingEvidenceFiles.shift();

      try {
        console.log(
          `[AUTO] Downloading evidence ${task.fileId} for ${task.account}`
        );

        const result = await callTool(
          "get_new_account_file",
          {
            account: task.account,
            file_id: task.fileId,
          }
        );

        const evidenceText = extractEvidenceText(result);

        const filePath = path.join(
          FILES_DIR,
          `${task.fileId}.txt`
        );

        fs.writeFileSync(
          filePath,
          evidenceText,
          "utf8"
        );

        console.log(
          `[AUTO] Evidence ${task.fileId} downloaded successfully`
        );

      } catch (error) {
        pendingEvidenceFiles.push(task);

        console.error(
          `[AUTO] Evidence ${task.fileId} failed:`,
          error.message
        );
      }

      return;
    }

    // 3. No pending work: discover newly released accounts.
    console.log("[AUTO] Checking for new accounts...");

    const identity = await callTool("whoami");

    saveData("whoami.json", identity);

    const newAccounts = queueNewAccounts(identity);

    // Also check for missing files in previously saved exports.
    const newFiles = queueMissingEvidenceFiles();

    console.log(
      `[AUTO] ${newAccounts} new account(s), ${newFiles} missing evidence file(s) queued.`
    );

  } catch (error) {
    console.error(
      "[AUTO] Discovery failed:",
      error.message
    );
  } finally {
    autoDiscoveryBusy = false;
  }
}

// ---------------- DASHBOARD ----------------

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "../public/index.html")
  );
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
      const seconds = Math.ceil(
        (nextMcpCallAt - now) / 1000
      );

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

    const queued = queueNewAccounts(result);

    const queuedFiles = queueMissingEvidenceFiles();

    res.json({
      success: true,
      data: result,
      queued_accounts: queued,
      queued_evidence_files: queuedFiles,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- FETCH ADDITIONAL ACCOUNT ----------------

app.post("/api/mcp/new-account", async (req, res) => {
  try {
    const account = String(req.body?.account || "").trim();

    if (!isValidAccountId(account)) {
      return res.status(400).json({
        success: false,
        error: "Invalid account ID",
      });
    }

    const identity = readJSON("whoami.json");

    const availableAccounts = identity?.new_accounts || [];

    const isAvailable = availableAccounts.some(
      item => String(item?.id) === account
    );

    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        error: "Account is not listed in whoami.new_accounts. Refresh identity first.",
      });
    }

    const result = await callTool("get_new_account", {
      account,
    });

    const matchingAccount = (
      result?.accounts || []
    ).find(
      item => String(item?.id) === account
    );

    if (!matchingAccount) {
      throw new Error(
        `MCP export did not contain account ${account}`
      );
    }

    saveData(`account_${account}.json`, result);

    const queuedFiles = queueEvidenceFiles(
      result,
      account
    );

    pendingAccountIds = pendingAccountIds.filter(
      id => id !== account
    );

    res.json({
      success: true,
      source: "Questathon MCP",
      account,
      queued_evidence_files: queuedFiles,
      data: result,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- FETCH ONE EVIDENCE FILE ----------------

app.post("/api/mcp/new-account-file", async (req, res) => {
  try {
    const account = String(req.body?.account || "").trim();
    const fileId = String(req.body?.file_id || "").trim();

    if (!isValidAccountId(account) || !isValidFileId(fileId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid account or file ID",
      });
    }

    const accountExport = readJSON(`account_${account}.json`);

    const fileExists = (
      accountExport?.files || []
    ).some(file => String(file?.id) === fileId);

    if (!fileExists) {
      return res.status(404).json({
        success: false,
        error: "File is not listed in this account export",
      });
    }

    const result = await callTool(
      "get_new_account_file",
      {
        account,
        file_id: fileId,
      }
    );

    const evidenceText = extractEvidenceText(result);

    fs.writeFileSync(
      path.join(FILES_DIR, `${fileId}.txt`),
      evidenceText,
      "utf8"
    );

    pendingEvidenceFiles = pendingEvidenceFiles.filter(
      item =>
        !(item.account === account && item.fileId === fileId)
    );

    res.json({
      success: true,
      account,
      file_id: fileId,
      message: "Evidence file downloaded successfully",
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- DASHBOARD ACCOUNTS ----------------

app.get("/api/accounts", (req, res) => {
  try {
    res.json(getDashboardData());

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
  res.json(
    readJSON("notes.json") || {
      notes: [],
    }
  );
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

  if (!isValidFileId(id)) {
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

  const filePath = path.join(
    FILES_DIR,
    `${id}.txt`
  );

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

  // Recover pending evidence downloads after a restart.
  const queued = queueMissingEvidenceFiles();

  console.log(
    `[STARTUP] ${queued} missing evidence file(s) queued`
  );

  // First automatic check.
  setTimeout(() => {
    runAutoDiscovery();
  }, 15_000);

  // One automatic MCP task every 65 seconds.
  setInterval(() => {
    runAutoDiscovery();
  }, 65_000);
});
