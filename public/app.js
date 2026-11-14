const $ = (id) => document.getElementById(id);

let accountsData = null;
let signalsData = { signals: [] };
let notesData = { notes: [] };
let selectedAccountId = "A";
let currentView = "brief";
let signalTimer = null;
let checkingSignals = false;

const VIEW_TITLES = {
  brief: ["ACCOUNT", "Monday brief"],
  book: ["QUESTION 1", "What is the book worth?"],
  power: ["QUESTION 2", "Who holds the power?"],
  moves: ["QUESTION 3", "What do you do first?"],
  risks: ["QUESTION 4", "What is about to go wrong?"],
  gaps: ["QUESTION 5", "What do you still not know?"],
  evidence: ["RECORD", "Evidence"],
  signals: ["LIVE", "Signals"]
};

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return "$" + number.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function getSelectedAccount() {
  return accountsData?.accounts?.find(
    (account) => String(account.id) === selectedAccountId
  );
}

function fileSet() {
  return new Set((accountsData?.files || []).map((file) => file.id));
}

function factById(account, id) {
  return (account.facts || []).find((fact) => fact.id === id);
}

function personByName(account, name) {
  return (account.stakeholders || []).find((person) => person.name === name);
}

function stanceClass(relationship) {
  const value = String(relationship || "").toLowerCase();
  if (value.includes("ally") || value.includes("warm")) return "green";
  if (value.includes("hostile") || value.includes("block")) return "red";
  return "orange";
}

function powerFromRole(role) {
  const text = String(role || "").toLowerCase();
  const slots = [];
  if (/finance|controller/.test(text)) slots.push("Pays");
  if (/procurement/.test(text)) slots.push("Runs the buy");
  if (/data protection|protection officer|insurance|risk/.test(text)) slots.push("Can block");
  if (/inspector|plant manager|operator/.test(text)) slots.push("Uses it");
  if (/programme lead|head of security/.test(text)) slots.push("Owns the programme");
  return slots.length ? slots : ["Role does not say"];
}

function classifyDeal(account, opportunity) {
  const files = fileSet();
  const cites = [];
  let backed = false;

  for (const id of opportunity.evidence || []) {
    if (files.has(id)) {
      backed = true;
      cites.push({ id, kind: "file" });
      continue;
    }

    const fact = factById(account, id);
    if (!fact) {
      cites.push({ id, kind: "unknown" });
      continue;
    }

    cites.push({
      id,
      kind: fact.status || "told",
      text: fact.text,
      by: fact.said_by
    });

    if (fact.status === "verified") backed = true;
  }

  return { backed, cites };
}

function ownerFor(account, opportunity) {
  const people = [];

  for (const id of opportunity.evidence || []) {
    const fact = factById(account, id);
    if (!fact || fact.status === "claim" || !fact.said_by) continue;
    const person = personByName(account, fact.said_by);
    if (person && person.available !== false && !people.some((item) => item.id === person.id)) {
      people.push(person);
    }
  }

  const rank = { ally: 0, warm: 1, neutral: 2 };
  people.sort((a, b) => (rank[a.relationship] ?? 3) - (rank[b.relationship] ?? 3));
  return people[0] || null;
}

function rankedMoves(account) {
  const open = (account.opportunities || []).filter((opportunity) => {
    const status = String(opportunity.blocker?.status || "").toLowerCase();
    const deadline = opportunity.deadline;
    const deadlineOpen = deadline && deadline.met === false && deadline.passed === false;
    return status.includes("open") || deadlineOpen;
  });

  return open
    .map((opportunity) => ({ opportunity, review: classifyDeal(account, opportunity) }))
    .sort((a, b) => {
      const urgency = (item) => {
        const deadline = item.opportunity.deadline;
        if (deadline && deadline.passed) return 0;
        if (deadline && deadline.met === false) return 1;
        return 2;
      };
      const gap = urgency(a) - urgency(b);
      if (gap !== 0) return gap;
      return (Number(b.opportunity.worth_up_to) || 0) - (Number(a.opportunity.worth_up_to) || 0);
    })
    .slice(0, 3);
}

function contradictions(account) {
  const pairs = [];

  for (const fact of account.facts || []) {
    if (!/_0$/.test(fact.id)) continue;
    const stem = fact.id.slice(0, -1);
    const later = (account.facts || []).find((item) => {
      return item.id !== fact.id && item.id.startsWith(stem) && item.status !== "claim";
    });
    if (later) pairs.push({ claim: fact, later });
  }

  return pairs;
}

function risksFor(account) {
  const items = [];
  const seen = new Set();

  for (const opportunity of account.opportunities || []) {
    const status = String(opportunity.blocker?.status || "").toLowerCase();
    if (status.includes("open")) {
      items.push({
        title: opportunity.title,
        detail: opportunity.blocker?.text || "Blocker is open.",
        when: opportunity.deadline?.text || "No date. The blocker is already open.",
        sources: [opportunity.id, ...(opportunity.evidence || [])]
      });
    }

    if (opportunity.deadline && opportunity.deadline.met === false && !opportunity.deadline.passed) {
      const when = opportunity.deadline.moves_left != null
        ? `${opportunity.deadline.moves_left} moves left on the record`
        : "Not marked passed, and not marked met";
      items.push({
        title: "Deadline still open",
        detail: opportunity.deadline.text,
        when,
        sources: [opportunity.id]
      });
      seen.add(opportunity.deadline.text);
    }

    if (opportunity.deadline?.passed) {
      items.push({
        title: "Deadline passed",
        detail: opportunity.deadline.text,
        when: "Already passed on the record",
        sources: [opportunity.id]
      });
      seen.add(opportunity.deadline.text);
    }
  }

  for (const deadline of account.deadlines || []) {
    if (seen.has(deadline.text)) continue;
    items.push({
      title: deadline.passed ? "Deadline passed" : "Account deadline",
      detail: deadline.text,
      when: deadline.passed ? "Already passed on the record" : "Not marked passed",
      sources: []
    });
  }

  for (const pair of contradictions(account)) {
    items.push({
      title: `Claim ${pair.claim.id} is not the later record`,
      detail: `${pair.claim.text} Later (${pair.later.id}, ${pair.later.status}): ${pair.later.text}`,
      when: "Already on the record",
      sources: [pair.claim.id, pair.later.id, pair.later.verified_by].filter(Boolean)
    });
  }

  return items;
}

function gapsFor(account) {
  const gaps = [];

  for (const fact of account.facts || []) {
    if (fact.status !== "claim") continue;
    gaps.push({
      title: fact.text,
      why: "This is marked claim. It is not a number the book can rest on.",
      ask: fact.said_by || "The person who said it",
      sources: [fact.id]
    });
  }

  for (const opportunity of account.opportunities || []) {
    const review = classifyDeal(account, opportunity);
    if (review.backed) continue;
    const owner = ownerFor(account, opportunity);
    gaps.push({
      title: `${opportunity.title} has no file and no verified fact`,
      why: `${money(opportunity.worth_up_to)} is only a ceiling on ${opportunity.id}.`,
      ask: owner ? owner.name : "Nobody named in the non-claim evidence",
      sources: [opportunity.id, ...(opportunity.evidence || [])]
    });
  }

  for (const opportunity of account.opportunities || []) {
    if (opportunity.deadline) continue;
    if (!String(opportunity.blocker?.status || "").toLowerCase().includes("open")) continue;
    gaps.push({
      title: `${opportunity.title} has an open blocker and no date`,
      why: "The first-move list cannot put a date on it because the record has none.",
      ask: ownerFor(account, opportunity)?.name || "No owner in the evidence",
      sources: [opportunity.id]
    });
  }

  return gaps;
}

function sourceButtons(ids) {
  const files = fileSet();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return `<span class="pill">No id on this line</span>`;

  return `<div class="sources">${unique.map((id) => `
    <button
      type="button"
      class="source"
      data-source="${escapeHTML(id)}"
      data-file="${files.has(id) ? "1" : "0"}"
    >${escapeHTML(id)}</button>
  `).join("")}</div>`;
}

function showView(view) {
  currentView = view;

  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const [kicker, title] = VIEW_TITLES[view] || ["ACCOUNT", "Monday brief"];
  $("viewKicker").textContent = kicker;
  $("viewTitle").textContent = title;
}

function renderAccountTabs() {
  document.querySelectorAll(".account-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.account === selectedAccountId);
  });
}

function renderBrief(account) {
  const deals = (account.opportunities || []).map((opportunity) => ({
    opportunity,
    review: classifyDeal(account, opportunity)
  }));
  const backed = deals.filter((deal) => deal.review.backed);
  const apart = deals.filter((deal) => !deal.review.backed);
  const backedSum = backed.reduce((sum, deal) => sum + (Number(deal.opportunity.worth_up_to) || 0), 0);
  const apartSum = apart.reduce((sum, deal) => sum + (Number(deal.opportunity.worth_up_to) || 0), 0);
  const pitches = (account.offers || []).reduce((sum, offer) => sum + (Number(offer.value) || 0), 0);
  const move = rankedMoves(account)[0];
  const risk = risksFor(account)[0];
  const gap = gapsFor(account)[0];

  $("briefBody").innerHTML = `
    <div class="stats">
      <button class="stat" type="button" data-open="book">
        <span>Ceiling with a file or a verified fact</span>
        <strong>${money(backedSum)}</strong>
        <em>${backed.map((deal) => deal.opportunity.id).join(", ") || "None"}</em>
      </button>
      <button class="stat" type="button" data-open="book">
        <span>Ceiling kept apart. Not backed.</span>
        <strong>${money(apartSum)}</strong>
        <em>${apart.map((deal) => deal.opportunity.id).join(", ") || "None"}</em>
      </button>
      <button class="stat" type="button" data-open="book">
        <span>Open pitches. Not in the book.</span>
        <strong>${money(pitches)}</strong>
        <em>${(account.offers || []).map((offer) => offer.id).join(", ") || "None"}</em>
      </button>
    </div>
    <article class="card">
      <div class="card-top">
        <h3>First move</h3>
        <button class="ghost" type="button" data-open="moves">Open</button>
      </div>
      <p>${move ? escapeHTML(move.opportunity.blocker?.text || move.opportunity.title) : "No open move on the record."}</p>
      ${move ? sourceButtons([move.opportunity.id]) : ""}
    </article>
    <article class="card">
      <div class="card-top">
        <h3>Nearest trouble</h3>
        <button class="ghost" type="button" data-open="risks">Open</button>
      </div>
      <p>${risk ? escapeHTML(risk.detail) : "No open blocker, missed deadline, or contradicted claim on this account."}</p>
      ${risk ? sourceButtons(risk.sources) : ""}
    </article>
    <article class="card">
      <div class="card-top">
        <h3>Sharpest gap</h3>
        <button class="ghost" type="button" data-open="gaps">Open</button>
      </div>
      <p>${gap ? escapeHTML(gap.title) : "No claim or unbacked ceiling on this account."}</p>
      ${gap ? `<p class="meta">Ask ${escapeHTML(gap.ask)}</p>${sourceButtons(gap.sources)}` : ""}
    </article>
  `;
}

function renderBook(account) {
  const deals = (account.opportunities || []).map((opportunity) => ({
    opportunity,
    review: classifyDeal(account, opportunity)
  }));
  const backed = deals.filter((deal) => deal.review.backed);
  const apart = deals.filter((deal) => !deal.review.backed);
  const sum = (rows) => rows.reduce((total, deal) => total + (Number(deal.opportunity.worth_up_to) || 0), 0);

  const dealCard = (deal) => `
    <article class="card">
      <div class="card-top">
        <h3>${escapeHTML(deal.opportunity.title)}</h3>
        <span class="money ${deal.review.backed ? "" : "apart"}">${money(deal.opportunity.worth_up_to)}</span>
      </div>
      <div class="pills">
        <span class="pill">${escapeHTML(deal.opportunity.id)}</span>
        <span class="pill">${escapeHTML(deal.opportunity.stage || "stage not set")}</span>
        <span class="pill ${deal.review.backed ? "green" : "orange"}">
          ${deal.review.backed ? "Ceiling has a file or a verified fact" : "Kept apart"}
        </span>
      </div>
      <p class="meta">worth_up_to on ${escapeHTML(deal.opportunity.id)}. This is a ceiling on the record, not cash booked.</p>
      ${sourceButtons([deal.opportunity.id, ...(deal.opportunity.evidence || [])])}
    </article>
  `;

  const offers = (account.offers || []).map((offer) => `
    <article class="card">
      <div class="card-top">
        <h3>${escapeHTML(offer.title)}</h3>
        <span class="money apart">${money(offer.value)}</span>
      </div>
      <p class="meta">Pitch ${escapeHTML(offer.id)} to ${escapeHTML(offer.pitch_to || "nobody named")}. Status: ${escapeHTML(offer.status || "unknown")}. Not added to either ceiling.</p>
      ${sourceButtons([offer.id])}
    </article>
  `).join("");

  $("bookBody").innerHTML = `
    <div class="stats">
      <div class="stat"><span>Backed ceilings</span><strong>${money(sum(backed))}</strong></div>
      <div class="stat"><span>Not backed</span><strong>${money(sum(apart))}</strong></div>
      <div class="stat"><span>Pitches, excluded</span><strong>${money((account.offers || []).reduce((total, offer) => total + (Number(offer.value) || 0), 0))}</strong></div>
    </div>
    <h2 class="section-label">Each deal</h2>
    ${deals.map(dealCard).join("") || `<div class="empty">No opportunities on this account.</div>`}
    <h2 class="section-label">Pitches kept out of the book</h2>
    ${offers || `<div class="empty">No offers on this account.</div>`}
  `;
}

function renderPower(account) {
  const people = (account.stakeholders || []).map((person) => `
    <article class="card person">
      <h3>${escapeHTML(person.name || "Unnamed")}</h3>
      <p>${escapeHTML(person.role || "Role not on the record")}</p>
      <div class="pills">
        <span class="pill ${stanceClass(person.relationship)}">${escapeHTML(person.relationship || "stance not set")}</span>
        ${person.available === false ? `<span class="pill red">Unavailable</span>` : ""}
        ${powerFromRole(person.role).map((slot) => `<span class="pill">${escapeHTML(slot)}</span>`).join("")}
      </div>
      <p class="meta">Stance is the relationship field on ${escapeHTML(person.id)}. The slot comes from the role title, not from a guessed motive.</p>
      ${sourceButtons([person.id])}
    </article>
  `).join("");

  const deals = (account.opportunities || []).map((opportunity) => {
    const names = [];
    for (const id of opportunity.evidence || []) {
      const fact = factById(account, id);
      if (fact?.said_by && !names.includes(fact.said_by)) names.push(fact.said_by);
    }
    return `
      <article class="card">
        <h3>${escapeHTML(opportunity.title)}</h3>
        <p>People named in this deal's evidence: ${names.length ? escapeHTML(names.join(", ")) : "none"}.</p>
        <p class="meta">Blocker: ${escapeHTML(opportunity.blocker?.text || "none on the record")} (${escapeHTML(opportunity.blocker?.status || "unknown")}).</p>
        ${sourceButtons([opportunity.id, ...(opportunity.evidence || [])])}
      </article>
    `;
  }).join("");

  $("powerBody").innerHTML = `
    <p class="hint">A person is listed as payer, user, blocker, or programme owner only when those words are in the role title. If the role does not say, the card says so.</p>
    <div class="people">${people || `<div class="empty">No stakeholders on this account.</div>`}</div>
    ${deals}
  `;
}

function renderMoves(account) {
  const moves = rankedMoves(account);

  if (!moves.length) {
    $("movesBody").innerHTML = `<div class="empty">No open blocker and no unmet deadline on this account.</div>`;
    return;
  }

  $("movesBody").innerHTML = moves.map((move, index) => {
    const opportunity = move.opportunity;
    const owner = ownerFor(account, opportunity);
    const date = opportunity.deadline?.text || "No date on the record";
    return `
      <article class="card move">
        <div class="rank">${index + 1}</div>
        <div>
          <h3>${escapeHTML(opportunity.blocker?.text || opportunity.title)}</h3>
          <p>Deal: ${escapeHTML(opportunity.title)}</p>
          <div class="pills">
            <span class="pill">Owner: ${escapeHTML(owner ? owner.name : "No owner named in the non-claim evidence")}</span>
            <span class="pill ${opportunity.deadline ? "orange" : "red"}">Date: ${escapeHTML(date)}</span>
          </div>
          <p class="meta">Rank rule: passed or still-open deadlines first, then the larger open ceiling. Owner is the available person behind a non-claim fact in the evidence. Ally, then warm, then neutral.</p>
          ${sourceButtons([opportunity.id, owner?.id, ...(opportunity.evidence || [])])}
        </div>
      </article>
    `;
  }).join("");
}

function renderRisks(account) {
  const risks = risksFor(account);

  if (!risks.length) {
    $("risksBody").innerHTML = `<div class="empty">Nothing on this account is an open blocker, a missed deadline, or a claim later contradicted. That is not the same as all clear.</div>`;
    return;
  }

  $("risksBody").innerHTML = risks.map((risk) => `
    <article class="card">
      <h3>${escapeHTML(risk.title)}</h3>
      <p>${escapeHTML(risk.detail)}</p>
      <p class="meta">When it turns: ${escapeHTML(risk.when)}</p>
      ${sourceButtons(risk.sources)}
    </article>
  `).join("");
}

function renderGaps(account) {
  const gaps = gapsFor(account);

  if (!gaps.length) {
    $("gapsBody").innerHTML = `<div class="empty">No claims, unbacked ceilings, or undated open blockers on this account.</div>`;
    return;
  }

  $("gapsBody").innerHTML = gaps.map((gap) => `
    <article class="card">
      <h3>${escapeHTML(gap.title)}</h3>
      <p>${escapeHTML(gap.why)}</p>
      <p class="meta">Who could fill it: ${escapeHTML(gap.ask)}</p>
      ${sourceButtons(gap.sources)}
    </article>
  `).join("");
}

function renderEvidence(account) {
  const files = (accountsData.files || []).filter((file) => String(file.account) === String(account.id));
  $("evidenceLabel").textContent = `${files.length} files`;

  if (!files.length) {
    $("evidenceList").innerHTML = `<div class="empty">No files stored for this account.</div>`;
    return;
  }

  $("evidenceList").innerHTML = files.map((file) => `
    <div class="evidence-file">
      <div>
        <strong>${escapeHTML(file.title || file.id)}</strong>
        <span>${escapeHTML(file.id)}</span>
      </div>
      <button class="source" type="button" data-source="${escapeHTML(file.id)}" data-file="1">Open</button>
    </div>
  `).join("");
}

function renderSignals() {
  const signals = Array.isArray(signalsData) ? signalsData : signalsData?.signals || [];

  if (!signals.length) {
    $("signalsList").innerHTML = `
      <div class="empty">
        No signals in the saved response. An empty list is not a green account.
        Risks already on the record stay on "About to go wrong".
      </div>
    `;
    return;
  }

  $("signalsList").innerHTML = signals.map((signal) => {
    const title = signal.title || signal.name || signal.type || signal.kind || "Signal";
    const description = signal.description || signal.text || signal.message || signal.summary || "";
    return `
      <article class="card">
        <h3>${escapeHTML(title)}</h3>
        <p>${escapeHTML(description || "No description field on this signal.")}</p>
        ${sourceButtons([signal.id, signal.account].filter(Boolean))}
      </article>
    `;
  }).join("");
}

function renderNotes() {
  const notes = (notesData.notes || []).filter((note) => {
    return !note.account || String(note.account) === selectedAccountId;
  });

  if (!notes.length) {
    $("notesList").innerHTML = `<div class="empty">No notes written from this CRM yet.</div>`;
    return;
  }

  $("notesList").innerHTML = notes.slice().reverse().map((note) => `
    <article class="card">
      <div class="pills">
        <span class="pill">${escapeHTML(note.kind || "note")}</span>
        <span class="pill">${escapeHTML(note.account || "no account")}</span>
      </div>
      <h3>${escapeHTML(note.title || "Untitled note")}</h3>
      <p>${escapeHTML(note.text || "")}</p>
    </article>
  `).join("");
}

function renderAccount() {
  const account = getSelectedAccount();
  if (!account) {
    $("accountSummary").textContent = "That account is not in the saved record.";
    return;
  }

  renderAccountTabs();
  $("accountSummary").textContent =
    `Recorded story, not a valuation: ${account.official_story || "No story on the record."}`;

  renderBrief(account);
  renderBook(account);
  renderPower(account);
  renderMoves(account);
  renderRisks(account);
  renderGaps(account);
  renderEvidence(account);
  renderNotes();
}

async function loadEvidence(id) {
  showView("evidence");
  $("evidenceTitle").textContent = id;
  $("evidenceViewer").textContent = `Loading ${id}…`;

  try {
    const response = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
    const text = await response.text();
    $("evidenceViewer").textContent = response.ok
      ? text
      : `Could not open ${id}. ${text}`;
  } catch (error) {
    $("evidenceViewer").textContent = error.message;
  }
}

function showCite(id) {
  const account = getSelectedAccount();
  const fact = account && factById(account, id);
  const person = account?.stakeholders?.find((item) => item.id === id);
  const opportunity = account?.opportunities?.find((item) => item.id === id);
  const offer = account?.offers?.find((item) => item.id === id);
  const bar = $("citeBar");
  bar.hidden = false;

  if (fact) {
    bar.textContent = `${fact.id} · ${fact.status}${fact.verified_by ? ` · verified by ${fact.verified_by}` : ""} · ${fact.said_by || "speaker not named"}: ${fact.text}`;
    return;
  }

  if (person) {
    bar.textContent = `${person.id} · ${person.name} · ${person.role} · relationship ${person.relationship}`;
    return;
  }

  if (opportunity) {
    bar.textContent = `${opportunity.id} · ${opportunity.title} · worth_up_to ${money(opportunity.worth_up_to)} · blocker ${opportunity.blocker?.status || "unknown"}`;
    return;
  }

  if (offer) {
    bar.textContent = `${offer.id} · ${offer.title} · value ${money(offer.value)} · pitch to ${offer.pitch_to || "nobody named"}`;
    return;
  }

  bar.textContent = `${id} is cited here. It is not a fact, person, deal, or offer on this account.`;
}

async function refreshSignals(silent) {
  if (checkingSignals) return;
  checkingSignals = true;
  const button = $("refreshBtn");
  button.disabled = true;
  $("liveStatus").textContent = "Checking signals…";

  try {
    const response = await fetch("/api/signals/refresh", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Signal check failed");

    signalsData = payload.data ?? payload;
    renderSignals();
    const count = (Array.isArray(signalsData) ? signalsData : signalsData.signals || []).length;
    $("liveStatus").textContent = count
      ? `${count} signal${count === 1 ? "" : "s"} in the latest check`
      : "Latest check returned no new signals";
  } catch (error) {
    $("liveStatus").textContent = error.message;
    if (!silent) $("noteStatus").textContent = "";
  } finally {
    checkingSignals = false;
    button.disabled = false;
  }
}

async function loadInitialData() {
  const [accountsResponse, signalsResponse, notesResponse] = await Promise.all([
    fetch("/api/accounts"),
    fetch("/api/signals"),
    fetch("/api/notes")
  ]);

  if (!accountsResponse.ok) throw new Error("Saved accounts could not be loaded");

  accountsData = await accountsResponse.json();
  signalsData = signalsResponse.ok ? await signalsResponse.json() : { signals: [] };
  notesData = notesResponse.ok ? await notesResponse.json() : { notes: [] };

  renderAccount();
  renderSignals();
  showView("brief");
}

document.querySelector(".sidebar").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  showView(button.dataset.view);
});

document.querySelector(".main").addEventListener("click", (event) => {
  const open = event.target.closest("[data-open]");
  if (open) {
    showView(open.dataset.open);
    return;
  }

  const source = event.target.closest("[data-source]");
  if (!source) return;
  if (source.dataset.file === "1") loadEvidence(source.dataset.source);
  else showCite(source.dataset.source);
});

document.querySelectorAll(".account-tab").forEach((button) => {
  button.addEventListener("click", () => {
    selectedAccountId = button.dataset.account;
    $("citeBar").hidden = true;
    renderAccount();
  });
});

$("refreshBtn").addEventListener("click", () => refreshSignals(false));

$("noteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("noteStatus");
  const data = new FormData(form);
  status.textContent = "Writing…";

  try {
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: selectedAccountId,
        kind: data.get("kind"),
        title: data.get("title"),
        text: data.get("text")
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Note was not saved");
    notesData = payload;
    form.reset();
    status.textContent = "Note written back.";
    renderNotes();
  } catch (error) {
    status.textContent = error.message;
  }
});

loadInitialData().catch((error) => {
  $("accountSummary").innerHTML = `<span class="error">${escapeHTML(error.message)}</span>`;
});

signalTimer = window.setInterval(() => refreshSignals(true), 70000);
