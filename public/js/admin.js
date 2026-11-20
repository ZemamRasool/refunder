// Admin dashboard. Every request here is checked on the server and written to the audit log.
import { api, el, initAuth, message, money, signOut, totalsText } from "./auth.js";

const $ = (id) => document.getElementById(id);
const when = (d) => (d ? new Date(d).toLocaleString() : "—");

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("app-view").classList.toggle("hidden", view !== "app");
  $("logout").classList.toggle("hidden", view === "login");
}

function btn(label, kind, onclick) {
  const b = el("button", { class: `btn btn-sm ${kind}`, type: "button" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onclick();
      await refresh();
    } catch (err) {
      message($("admin-msg"), err.message, false);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function tile(label, value, sub) {
  return el("div", { class: "card tile" }, el("div", { class: "muted small" }, label), el("div", { class: "big" }, value), sub ? el("div", { class: "muted small" }, sub) : "");
}

async function loadOverview() {
  const o = await api("/api/admin/overview");
  const c = o.claims;
  $("tiles").replaceChildren(
    tile("Users", String(o.users), `${o.newUsers30d} new in 30 days · ${o.waitlist} on waitlist`),
    tile("Receipts", String((o.receipts.parsed || 0) + (o.receipts.pending || 0) + (o.receipts.failed || 0)), `${o.receipts.failed || 0} failed · ${o.receipts.pending || 0} waiting`),
    tile("Claims", String(Object.values(c).reduce((a, b) => a + b, 0)), `${c.found || 0} new · ${c.sent || 0} sent · ${c.won || 0} won · ${c.lost || 0} lost`),
    tile("Recovered for users", totalsText(o.recovered) || "0"),
    tile("Fees paid", totalsText(o.feesPaid) || "0", `Outstanding: ${totalsText(o.feesOutstanding) || "0"}`),
    tile("Background jobs", `${o.jobs.failed} failed`, `${o.jobs.waiting} waiting`),
  );
}

async function loadPayouts() {
  const status = $("payout-filter").value;
  const rows = await api(`/api/admin/payouts${status ? `?status=${status}` : ""}`);
  const tbody = $("payouts");
  tbody.replaceChildren();
  if (!rows.length) tbody.append(el("tr", {}, el("td", { colspan: "6", class: "muted" }, "No fees yet.")));
  for (const p of rows) {
    const actions = el("td", { class: "row" });
    if (["pending", "failed", "processing"].includes(p.status)) actions.append(btn("Mark paid", "btn-primary", () => api(`/api/admin/payouts/${p.id}/mark-paid`, { method: "POST" })));
    if (p.provider === "stripe" && ["pending", "failed"].includes(p.status)) actions.append(btn("Retry charge", "btn-ghost", () => api(`/api/admin/payouts/${p.id}/retry`, { method: "POST" })));
    if (["pending", "failed"].includes(p.status)) actions.append(btn("Waive", "btn-ghost", () => api(`/api/admin/payouts/${p.id}/waive`, { method: "POST" })));
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, p.user),
        el("td", {}, money(p.recoveredAmount, p.currency)),
        el("td", { class: "num-cell" }, `${money(p.feeAmount, p.currency)} (${p.feePercent}%)`),
        el("td", {}, el("span", { class: `pill ${p.status}` }, p.status), p.failureReason ? el("div", { class: "err" }, p.failureReason) : ""),
        el("td", { class: "small" }, when(p.paidAt || p.createdAt)),
        actions,
      ),
    );
  }
}

async function loadRules() {
  const rules = await api("/api/admin/rules");
  const tbody = $("rules");
  tbody.replaceChildren();
  for (const r of rules) {
    const toggle = el("input", { type: "checkbox", checked: r.active, "aria-label": `Active: ${r.name}` });
    toggle.addEventListener("change", async () => {
      try {
        await api(`/api/admin/rules/${r.id}`, { method: "PATCH", body: { active: toggle.checked } });
      } catch (err) {
        toggle.checked = !toggle.checked;
        message($("admin-msg"), err.message, false);
      }
    });
    const c = r.counts;
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, el("div", { class: "strong" }, r.name), el("div", { class: "muted small" }, `${r.code} · ${r.country}`)),
        ...["found", "approved", "sent", "won", "lost", "dismissed"].map((s) => el("td", { class: "num-cell" }, String(c[s]))),
        el("td", { class: "num-cell" }, r.successRate === null ? "—" : `${Math.round(r.successRate * 100)}%`),
        el("td", {}, toggle),
      ),
    );
  }
}

async function loadClaims() {
  const status = $("claim-filter").value;
  const rows = await api(`/api/admin/claims${status ? `?status=${status}` : ""}`);
  const tbody = $("claims");
  tbody.replaceChildren();
  if (!rows.length) tbody.append(el("tr", {}, el("td", { colspan: "7", class: "muted" }, "No claims.")));
  for (const c of rows) {
    tbody.append(
      el(
        "tr",
        { title: c.reason },
        el("td", {}, c.user),
        el("td", {}, c.rule),
        el("td", {}, c.merchant || "—"),
        el("td", { class: "num-cell" }, money(c.expectedAmount, c.currency)),
        el("td", { class: "num-cell" }, money(c.recoveredAmount, c.currency)),
        el("td", {}, el("span", { class: `pill ${c.status}` }, c.status)),
        el("td", { class: "small" }, when(c.createdAt)),
      ),
    );
  }
}

async function loadJobs() {
  const jobs = await api("/api/admin/jobs");
  const tbody = $("jobs");
  tbody.replaceChildren();
  if (!jobs.length) tbody.append(el("tr", {}, el("td", { colspan: "3", class: "muted" }, "None. All good.")));
  for (const j of jobs) {
    tbody.append(el("tr", {}, el("td", {}, j.type), el("td", { class: "err" }, j.lastError || ""), el("td", {}, btn("Retry", "btn-ghost", () => api(`/api/admin/jobs/${j.id}/retry`, { method: "POST" })))));
  }
}

async function loadAudit() {
  const rows = await api("/api/admin/audit?limit=100");
  const tbody = $("audit");
  tbody.replaceChildren();
  for (const a of rows) {
    tbody.append(el("tr", {}, el("td", { class: "small" }, when(a.createdAt)), el("td", { class: "small" }, a.actorEmail || "system"), el("td", { class: "small" }, a.action, a.targetType ? ` · ${a.targetType}` : "")));
  }
}

async function refresh() {
  await Promise.all([loadOverview(), loadPayouts(), loadRules(), loadClaims(), loadJobs(), loadAudit()]);
}

async function start() {
  try {
    const me = await api("/api/me");
    $("who").textContent = me.email;
    if (!me.isAdmin) {
      show("login");
      message($("login-msg"), "This account is not an admin.", false);
      return;
    }
    show("app");
    await refresh();
  } catch (err) {
    message($("login-msg"), err.message, false);
  }
}

$("payout-filter").addEventListener("change", loadPayouts);
$("claim-filter").addEventListener("change", loadClaims);
$("logout").addEventListener("click", () => signOut());

initAuth({
  form: $("login-form"),
  googleBtn: $("google-btn"),
  hint: $("login-hint"),
  say: (text, ok) => message($("login-msg"), text, ok),
  onSignedIn: start,
  onSignedOut: () => show("login"),
});
