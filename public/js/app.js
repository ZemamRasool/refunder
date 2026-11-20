// The customer app: money found (claims), receipts, settings.
import { api, el, initAuth, message, money, signOut, totalsText } from "./auth.js";

const $ = (id) => document.getElementById(id);
let me = null;
let pollTimer = null;

const COUNTRY_NAMES = { GB: "United Kingdom", IE: "Ireland", US: "United States", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "Netherlands", CA: "Canada", AU: "Australia" };

function show(view) {
  for (const v of ["login", "onboard", "app"]) $(`${v}-view`).classList.toggle("hidden", v !== view);
  $("logout").classList.toggle("hidden", view === "login");
}

// ---------- tabs ----------
function openTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  if (name === "receipts") loadReceipts();
  if (name === "settings") loadSettings();
  if (name === "money") loadClaims();
}
document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => openTab(t.dataset.tab)));

// ---------- start ----------
async function start() {
  try {
    me = await api("/api/me");
  } catch {
    return;
  }
  $("who").textContent = me.email;
  $("admin-link").classList.toggle("hidden", !me.isAdmin);
  if (!me.onboarded) {
    $("fee-pct").textContent = `${me.feePercent}%`;
    const select = $("country");
    select.replaceChildren(el("option", { value: "" }, "Choose…"));
    for (const c of me.launchCountries) select.append(el("option", { value: c }, COUNTRY_NAMES[c] || c));
    select.append(el("option", { value: "OTHER" }, "Somewhere else"));
    show("onboard");
    return;
  }
  show("app");
  const params = new URLSearchParams(location.search);
  if (params.get("billing")) {
    history.replaceState(null, "", "/app");
    openTab("settings");
  } else openTab("money");
}

$("onboard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const country = f.country.value === "OTHER" ? "ZZ" : f.country.value;
    me = await api("/api/me/onboarding", { method: "POST", body: { country, acceptTerms: f.acceptTerms.checked } });
    show("app");
    openTab("money");
  } catch (err) {
    message($("onboard-msg"), err.message, false);
  }
});

// ---------- money found ----------
const STATUS_LABEL = { found: "New", approved: "Letter ready", sent: "Sent", won: "Won", lost: "Not paid", dismissed: "Dismissed" };

function flightForm(c) {
  const box = el("form", { class: "stack" });
  const choice = (value, label) => el("label", { class: "check" }, el("input", { type: "radio", name: "outcome", value, required: true }), el("span", {}, label));
  const hours = el("input", { type: "number", name: "hours", min: "0", max: "72", step: "0.25", placeholder: "Hours late at arrival", class: "inline-input" });
  const days = el("input", { type: "number", name: "days", min: "0", max: "365", placeholder: "Days' notice", class: "inline-input" });
  box.append(
    el("div", { class: "strong" }, c.question || "What happened to this flight?"),
    choice("delayed", "It arrived late"),
    hours,
    choice("cancelled", "It was cancelled"),
    days,
    choice("on_time", "It was on time"),
    el("button", { class: "btn btn-primary", type: "submit" }, "Check what I'm owed"),
  );
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const outcome = box.outcome.value;
    const body = { outcome };
    if (outcome === "delayed") body.arrivalDelayMinutes = Math.round(Number(box.hours.value || 0) * 60);
    if (outcome === "cancelled") body.noticeDays = Number(box.days.value || 0);
    await act(c.id, "flight-outcome", body);
  });
  return box;
}

function letterEditor(c) {
  const subject = el("input", { type: "text", value: c.letterSubject || "", "aria-label": "Subject" });
  const body = el("textarea", { rows: "12", "aria-label": "Letter" });
  body.value = c.letterText || "";
  const out = el("div");
  const copy = el("button", { class: "btn btn-ghost", type: "button" }, "Copy letter");
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(`Subject: ${subject.value}\n\n${body.value}`);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy letter"), 1500);
  });
  const save = el("button", { class: "btn btn-ghost", type: "button" }, "Save changes");
  save.addEventListener("click", async () => {
    try {
      await api(`/api/claims/${c.id}/letter`, { method: "PATCH", body: { subject: subject.value, body: body.value } });
      message(out, "Saved.", true);
    } catch (err) {
      message(out, err.message, false);
    }
  });
  return el(
    "div",
    { class: "stack" },
    el("p", { class: "muted small" }, "Check the letter, then send it to the company's customer support email or claims form, with your receipt attached. Nothing is sent automatically."),
    subject,
    body,
    el("div", { class: "row" }, copy, save, button("I've sent it", "btn-primary", () => act(c.id, "sent")), button("Not a claim", "btn-ghost", () => act(c.id, "dismiss"))),
    out,
  );
}

function button(label, kind, onclick) {
  const b = el("button", { class: `btn ${kind}`, type: "button" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onclick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function wonForm(c) {
  const amount = el("input", { type: "number", step: "0.01", min: "0.01", value: c.expectedAmount ?? "", class: "inline-input", "aria-label": "Amount received" });
  return el(
    "div",
    { class: "stack" },
    el("p", { class: "muted small" }, "Tell us when the company replies."),
    el(
      "div",
      { class: "row" },
      amount,
      button("I got the money", "btn-primary", () => act(c.id, "won", { recoveredAmount: Number(amount.value) })),
      button("They said no", "btn-ghost", () => act(c.id, "lost")),
    ),
  );
}

function claimCard(c) {
  const amount = c.status === "won" ? c.recoveredAmount : c.expectedAmount;
  const maxAmount = c.details && c.details.maxAmount;
  const head = el(
    "div",
    { class: "claim-head" },
    el("div", {}, el("div", { class: "strong" }, c.ruleName), el("div", { class: "muted small" }, c.merchant || "")),
    el(
      "div",
      { class: "right" },
      el("div", { class: "amount" }, amount !== null ? money(amount, c.currency) : maxAmount ? `up to ${money(maxAmount, c.currency)}` : "—"),
      el("span", { class: `pill ${c.status}` }, STATUS_LABEL[c.status] || c.status),
    ),
  );
  const body = el("div", { class: "stack" }, el("p", {}, c.reason));

  if (c.status === "found" && c.needsInput === "flight_outcome") body.append(flightForm(c));
  else if (c.status === "found") {
    const note = el("input", { type: "text", maxlength: "1000", placeholder: "Anything to add to the letter? (optional)" });
    body.append(
      c.question ? el("div", { class: "strong" }, c.question) : "",
      note,
      el(
        "div",
        { class: "row" },
        button(c.type === "forgotten_subscription" ? "I don't use it — write the letter" : "Yes — write the claim letter", "btn-primary", () => act(c.id, "approve", { note: note.value || undefined })),
        button(c.type === "forgotten_subscription" ? "I still use it" : "Not a claim", "btn-ghost", () => act(c.id, "dismiss")),
      ),
    );
  } else if (c.status === "approved") body.append(letterEditor(c));
  else if (c.status === "sent") body.append(wonForm(c));

  return el("article", { class: `card claim ${c.status}` }, head, body);
}

async function act(id, action, body) {
  try {
    await api(`/api/claims/${id}/${action}`, { method: "POST", body: body || {} });
    await loadClaims();
  } catch (err) {
    alertBox(err.message);
  }
}

function alertBox(text) {
  const box = $("pending-note");
  box.classList.remove("hidden", "ok");
  box.classList.add("bad");
  box.textContent = text;
  setTimeout(() => box.classList.add("hidden"), 6000);
}

async function loadClaims() {
  const data = await api("/api/claims");
  $("owed").textContent = totalsText(data.totals.owed) || "Nothing yet";
  $("recovered").textContent = totalsText(data.totals.recovered) || money(0, me.country === "GB" ? "GBP" : "EUR");

  const note = $("pending-note");
  note.classList.remove("bad");
  note.classList.add("ok");
  note.classList.toggle("hidden", !data.pendingReceipts);
  note.textContent = data.pendingReceipts ? `Reading ${data.pendingReceipts} receipt(s)… new findings will appear here.` : "";

  const groups = [
    ["Needs your answer", data.claims.filter((c) => c.status === "found")],
    ["In progress", data.claims.filter((c) => c.status === "approved" || c.status === "sent")],
    ["Finished", data.claims.filter((c) => ["won", "lost", "dismissed"].includes(c.status))],
  ];
  const list = $("claims");
  list.replaceChildren();
  if (!data.claims.length) {
    list.append(
      el(
        "div",
        { class: "card empty" },
        el("h2", {}, "No money found yet"),
        el("p", { class: "muted" }, "Forward or upload receipts from the last few months: online orders, subscriptions, and flight bookings. We check every one."),
        button("Add receipts", "btn-primary", () => openTab("receipts")),
      ),
    );
  }
  for (const [title, items] of groups) {
    if (!items.length) continue;
    list.append(el("h3", { class: "group-title" }, title));
    for (const c of items) list.append(claimCard(c));
  }
  schedulePoll(data.pendingReceipts > 0);
}

function schedulePoll(active) {
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(() => (document.querySelector('[data-panel="money"]:not(.hidden)') ? loadClaims() : loadReceipts()), 4000);
}

$("rescan").addEventListener("click", async () => {
  await api("/api/claims/scan", { method: "POST" });
  setTimeout(loadClaims, 1500);
});

// ---------- receipts ----------
async function loadReceipts() {
  $("fwd").textContent = me.forwardingAddress;
  const receipts = await api("/api/receipts");
  const tbody = $("rows");
  tbody.replaceChildren();
  if (!receipts.length) tbody.append(el("tr", {}, el("td", { colspan: "5", class: "muted" }, "No receipts yet. Forward one or upload a file.")));
  for (const r of receipts) {
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, r.merchant || (r.status === "failed" ? "Couldn't read" : "Reading…")),
        el("td", {}, r.purchaseDate || "—"),
        el("td", { class: "hide-sm" }, r.orderId || "—"),
        el("td", { class: "num-cell" }, money(r.amount, r.currency)),
        el("td", {}, el("span", { class: `pill ${r.status}` }, r.status), r.status === "failed" && r.error ? el("div", { class: "err" }, r.error) : ""),
      ),
    );
  }
  schedulePoll(receipts.some((r) => r.status === "pending"));
}

async function upload(file) {
  const out = $("upload-msg");
  if (!file) return;
  $("drop-text").textContent = `Uploading ${file.name}…`;
  message(out, "");
  try {
    const form = new FormData();
    form.append("file", file);
    const r = await api("/api/receipts", { method: "POST", body: form });
    message(out, r.duplicate ? "You already sent us this receipt." : "Got it. We're reading it now.", true);
    await loadReceipts();
  } catch (err) {
    message(out, err.message, false);
  } finally {
    $("drop-text").textContent = "Drop a file here or click to choose";
    $("file").value = "";
  }
}

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("fwd").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});
$("file").addEventListener("change", (e) => upload(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  upload(e.dataTransfer.files[0]);
});

// ---------- settings ----------
async function loadSettings() {
  const billing = await api("/api/billing");
  $("fee-line").textContent = `Our fee is ${me.feePercent}% of money you recover. If nothing is recovered, you pay nothing.`;
  const box = $("billing-box");
  box.replaceChildren();
  if (billing.provider === "stripe") {
    box.append(
      billing.paymentMethodReady
        ? el("p", { class: "msg ok" }, "Card saved. It is only charged after you confirm you got money back.")
        : el("div", { class: "stack" }, el("p", {}, "Add a card to approve claims. You're only charged after money is recovered."), button("Add a card", "btn-primary", async () => {
            const r = await api("/api/billing/setup", { method: "POST" });
            if (r.url) location.href = r.url;
          })),
    );
  } else {
    box.append(el("p", { class: "muted small" }, "No card needed. After a successful claim we'll send you an invoice for our fee."));
  }
  const fees = $("fees");
  fees.replaceChildren();
  if (billing.fees.length) {
    const tbody = el("tbody");
    for (const f of billing.fees) {
      tbody.append(el("tr", {}, el("td", {}, money(f.recoveredAmount, f.currency)), el("td", { class: "num-cell" }, money(f.feeAmount, f.currency)), el("td", {}, el("span", { class: `pill ${f.status}` }, f.status))));
    }
    fees.append(el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Recovered"), el("th", { class: "right" }, "Fee"), el("th", {}, "Status"))), tbody));
  }
}

$("rotate").addEventListener("click", async () => {
  if (!confirm("Your current forwarding address will stop working. Continue?")) return;
  me = await api("/api/me/rotate-address", { method: "POST" });
  message($("settings-msg"), `New address: ${me.forwardingAddress}`, true);
});
$("export").addEventListener("click", async () => {
  const data = await api("/api/me/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: "refundradar-export.json" });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
$("delete").addEventListener("click", async () => {
  const typed = prompt("This deletes your account, receipts and claims for good. Type DELETE to confirm.");
  if (typed !== "DELETE") return;
  try {
    await api("/api/me", { method: "DELETE", body: { confirm: "DELETE" } });
    await signOut();
  } catch (err) {
    message($("settings-msg"), err.message, false);
  }
});

$("logout").addEventListener("click", () => signOut());

initAuth({
  form: $("login-form"),
  googleBtn: $("google-btn"),
  hint: $("login-hint"),
  say: (text, ok) => message($("login-msg"), text, ok),
  onSignedIn: start,
  onSignedOut: () => show("login"),
});
