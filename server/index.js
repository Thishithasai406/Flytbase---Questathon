
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

// MCP allows one call per minute per token.
let nextMcpCallAt = 0;

// Automatic account discovery state.
let pendingAccountIds = [];
let autoDiscoveryBusy = false;

// ---------------- MCP HELPER ----------------

async function callTool(name, args = {}) {
  if (!process.env.AQ_TOKEN) {
    throw new Error("AQ_TOKEN is missing from .env");
  }

  const now = Date.now();

  if (now < nextMcpCallAt) {
    const seconds = Math.ceil((nextMcpCallAt - now) / 1000);

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

// ---------------- ACCOUNT HELPERS ----------------

function isValidAccountId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ""));
}

function getSavedAdditionalAccountIds() {
  const savedIds = new Set();

  const filenames = fs.readdirSync(DATA_DIR).filter(file =>
    /^account_[A-Za-z0-9_-]+\.json$/.test(file)
  );

  for (const filename of filenames) {
    try {
      const accountExport = readJSON(filename);

      const accounts = accountExport?.accounts || [];

      for (const account of accounts) {
        if (account?.id) {
          savedIds.add(String(account.id));
        }
      }
    } catch (error) {
      console.error(
        `Could not read ${filename}:`,
        error.message
      );
    }
  }

  return savedIds;
}

// Add newly released accounts to the pending queue.
function queueNewAccounts(identity) {
  const newAccounts = identity?.new_accounts || [];

  if (!Array.isArray(newAccounts)) {
    return 0;
  }

  const savedIds = getSavedAdditionalAccountIds();

  let added = 0;

  for (const item of newAccounts) {
    const accountId = String(item?.id || "").trim();

    if (!isValidAccountId(accountId)) {
      continue;
    }

    if (savedIds.has(accountId)) {
      continue;
    }

    if (pendingAccountIds.includes(accountId)) {
      continue;
    }

    pendingAccountIds.push(accountId);
    added++;
  }

  return added;
}

// ---------------- AUTOMATIC ACCOUNT DISCOVERY ----------------

async function runAutoDiscovery() {
  if (autoDiscoveryBusy || !process.env.AQ_TOKEN) {
    return;
  }

  autoDiscoveryBusy = true;

  try {
    // Fetch one pending account per MCP call.
    if (pendingAccountIds.length > 0) {
      const accountId = pendingAccountIds.shift();

      try {
        console.log(
          `[AUTO DISCOVERY] Fetching account ${accountId}`
        );

        const result = await callTool("get_new_account", {
          account: accountId,
        });

        const accounts = result?.accounts || [];

        const matchingAccount = accounts.find(
          account =>
            String(account?.id) === accountId
        );

        if (!matchingAccount) {
          throw new Error(
            `MCP export did not contain account ${accountId}`
          );
        }

        saveData(`account_${accountId}.json`, result);

        console.log(
          `[AUTO DISCOVERY] Account ${accountId} saved successfully`
        );

      } catch (error) {
        // Retry on the next discovery cycle.
        if (!pendingAccountIds.includes(accountId)) {
          pendingAccountIds.unshift(accountId);
        }

        console.error(
          `[AUTO DISCOVERY] Account ${accountId} failed:`,
          error.message
        );
      }

      return;
    }

    // No pending account: discover newly released accounts.
    console.log("[AUTO DISCOVERY] Checking for new accounts...");

    const identity = await callTool("whoami");

    saveData("whoami.json", identity);

    const added = queueNewAccounts(identity);

    console.log(
      `[AUTO DISCOVERY] Found ${added} new account(s) to fetch`
    );

  } catch (error) {
    console.error(
      "[AUTO DISCOVERY] Discovery failed:",
      error.message
    );
  } finally {
    autoDiscoveryBusy = false;
  }
}

// ---------------- DASHBOARD DATA ----------------

function getDashboardData() {
  // Prefer Questathon MCP export for A and B.
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

  // Load every saved additional account automatically.
  const accountFiles = fs.readdirSync(DATA_DIR).filter(file =>
    /^account_[A-Za-z0-9_-]+\.json$/.test(file)
  );

  for (const filename of accountFiles) {
    try {
      const accountExport = readJSON(filename);

      if (!accountExport) {
        continue;
      }

      const accounts = accountExport.accounts || [];

      for (const accountData of accounts) {
        if (!accountData?.id) {
          continue;
        }

        const accountId = String(accountData.id);

        // Avoid duplicate accounts.
        result.accounts = result.accounts.filter(
          account =>
            String(account.id) !== accountId
        );

        result.accounts.push(accountData);
      }

      // Merge evidence file metadata.
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

    // Automatically queue accounts discovered by this request.
    const queued = queueNewAccounts(result);

    res.json({
      success: true,
      data: result,
      queued_accounts: queued,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------------- FETCH ADDITIONAL ACCOUNTS ----------------

app.post("/api/mcp/new-account", async (req, res) => {
  try {
    const account = String(req.body?.account || "")
      .trim();

    if (!isValidAccountId(account)) {
      return res.status(400).json({
        success: false,
        error: "Invalid account ID.",
      });
    }

    // Only fetch accounts released to this player.
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

    const matchingAccount = (result?.accounts || []).find(
      item => String(item?.id) === account
    );

    if (!matchingAccount) {
      throw new Error(
        `MCP export did not contain account ${account}`
      );
    }

    saveData(`account_${account}.json`, result);

    // Remove it from the automatic queue if already queued.
    pendingAccountIds = pendingAccountIds.filter(
      id => id !== account
    );

    res.json({
      success: true,
      source: "Questathon MCP",
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

// ---------------- DASHBOARD ACCOUNTS ----------------

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

  // First automatic identity check after startup.
  setTimeout(() => {
    runAutoDiscovery();
  }, 15_000);

  // Repeat discovery every 65 seconds.
  // One MCP call per cycle, maximum.
  setInterval(() => {
    runAutoDiscovery();
  }, 65_000);
});
