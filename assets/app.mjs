import {
  activeOrderByCandidate,
  authErrorMessage,
  businessErrorMessage,
  formatDate,
  formatNumber,
  formatYen,
  isExpired,
  latestDecisionByCandidate,
  newRequestId,
  quoteUrl,
  selectRun,
  statusLabel,
} from "./domain.mjs";

const SESSION_KEY = "trading-dashboard-session-v1";
const config = window.TRADING_DASHBOARD_CONFIG || {};
const state = {
  session: null,
  user: null,
  profile: null,
  runs: [],
  selectedRun: null,
  candidates: [],
  decisions: [],
  orders: [],
  audits: [],
  refreshTimer: null,
  lockTimer: null,
  decisionPending: false,
};

const $ = (id) => document.getElementById(id);

function configReady() {
  return /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(String(config.supabaseUrl || ""))
    && String(config.supabasePublishableKey || "").length >= 20
    && !String(config.supabasePublishableKey).includes("__SUPABASE_");
}

function showOnly(screenId) {
  for (const id of ["boot-screen", "login-screen", "app-screen"]) $(id).hidden = id !== screenId;
}

function setMessage(text = "", type = "") {
  const node = $("app-message");
  node.textContent = text;
  node.className = `app-message ${type}`.trim();
}

function setConnection(online) {
  const node = $("connection-state");
  node.classList.toggle("offline", !online);
  node.lastChild.textContent = online ? "接続済み" : "オフライン";
}

function parsePayload(response) {
  return response.text().then((text) => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
  });
}

async function authRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("apikey", config.supabasePublishableKey);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw Object.assign(new Error("通信できません。接続後に再試行してください。"), { status: 0 });
  }
  const payload = await parsePayload(response);
  if (!response.ok) {
    throw Object.assign(new Error(authErrorMessage(response.status, payload || {})), {
      status: response.status,
      payload,
    });
  }
  return payload;
}

function storeSession(session) {
  const expiresAt = session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
  state.session = { ...session, expires_at: expiresAt };
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: state.session.access_token,
    refresh_token: state.session.refresh_token,
    expires_at: state.session.expires_at,
    token_type: "bearer",
  }));
  scheduleRefresh();
}

function readStoredSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function clearSensitiveState() {
  localStorage.removeItem(SESSION_KEY);
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  state.session = null;
  state.user = null;
  state.profile = null;
  state.runs = [];
  state.selectedRun = null;
  state.candidates = [];
  state.decisions = [];
  state.orders = [];
  state.audits = [];
  $("candidate-list").replaceChildren();
  $("decision-history").replaceChildren();
  $("paper-orders").replaceChildren();
  $("audit-events").replaceChildren();
}

function scheduleRefresh() {
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  const delay = Math.max(5_000, (Number(state.session?.expires_at || 0) * 1000) - Date.now() - 60_000);
  state.refreshTimer = window.setTimeout(async () => {
    try { await refreshSession(); } catch { await expireSession(); }
  }, delay);
}

async function refreshSession() {
  if (!state.session?.refresh_token) throw new Error("refresh token unavailable");
  const session = await authRequest("/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: state.session.refresh_token },
  });
  storeSession(session);
  return session;
}

async function ensureSession() {
  if (!state.session) return false;
  if (isExpired(state.session)) await refreshSession();
  return Boolean(state.session?.access_token);
}

async function expireSession() {
  clearSensitiveState();
  showOnly("login-screen");
  $("login-message").textContent = "セッションが終了しました。再度ログインしてください。";
}

async function businessRequest(path, options = {}, retry = true) {
  if (!state.session?.access_token) throw new Error("Unauthenticated business request blocked");
  const headers = new Headers(options.headers || {});
  headers.set("apikey", config.supabasePublishableKey);
  headers.set("Authorization", `Bearer ${state.session.access_token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch {
    setConnection(false);
    throw Object.assign(new Error("通信できません。接続後に再試行してください。"), { status: 0 });
  }
  setConnection(true);
  if ((response.status === 401 || response.status === 403) && retry) {
    try {
      await refreshSession();
      return businessRequest(path, options, false);
    } catch {
      await expireSession();
      throw Object.assign(new Error("セッションが終了しました。再度ログインしてください。"), { status: 401 });
    }
  }
  const payload = await parsePayload(response);
  if (!response.ok) {
    const message = payload?.message || payload?.hint || businessErrorMessage(response.status);
    throw Object.assign(new Error(message), { status: response.status, payload });
  }
  return payload;
}

function query(table, params = {}) {
  const search = new URLSearchParams(params);
  return businessRequest(`/${table}?${search.toString()}`);
}

async function signIn(email, password) {
  const session = await authRequest("/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  storeSession(session);
  state.user = session.user;
}

async function validateUser() {
  state.user = await authRequest("/user", { accessToken: state.session.access_token });
  return state.user;
}

async function signOut() {
  const token = state.session?.access_token;
  clearSensitiveState();
  showOnly("login-screen");
  $("login-form").reset();
  $("login-message").textContent = "ログアウトしました。";
  if (token) {
    try { await authRequest("/logout", { method: "POST", accessToken: token }); } catch { /* local logout remains authoritative */ }
  }
}

function setLoginLocked(seconds) {
  const button = $("login-button");
  button.disabled = true;
  let remaining = seconds;
  const render = () => {
    button.textContent = `再試行まで ${remaining}秒`;
    remaining -= 1;
    if (remaining < 0) {
      window.clearInterval(state.lockTimer);
      state.lockTimer = null;
      button.disabled = false;
      button.textContent = "ログイン";
    }
  };
  render();
  state.lockTimer = window.setInterval(render, 1000);
}

async function handleLogin(event) {
  event.preventDefault();
  if (!configReady()) {
    $("login-message").textContent = "公開用設定が未完了です。SUPABASE_PUBLISHABLE_KEYを登録してください。";
    return;
  }
  const button = $("login-button");
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    $("login-message").textContent = "メールアドレスとパスワードを入力してください。";
    return;
  }
  button.disabled = true;
  button.textContent = "確認中…";
  $("login-message").textContent = "";
  try {
    await signIn(email, password);
    $("password").value = "";
    await enterDashboard();
  } catch (error) {
    clearSensitiveState();
    $("login-message").textContent = error.message;
    if (error.status === 429) setLoginLocked(60);
  } finally {
    if (!state.lockTimer) {
      button.disabled = false;
      button.textContent = "ログイン";
    }
  }
}

async function loadProfileAndRuns() {
  const [profiles, runs] = await Promise.all([
    query("user_profiles", { select: "user_id,display_name,is_active", limit: "1" }),
    query("screening_runs", {
      select: "run_id,target_date,market,status,quality_status,finished_at,loaded_record_count,candidate_count,decision_eligible,code_version",
      order: "finished_at.desc",
      limit: "200",
    }),
  ]);
  state.profile = profiles[0] || null;
  if (!state.profile?.is_active) throw Object.assign(new Error("このアカウントは利用できません。"), { status: 403 });
  state.runs = runs || [];
}

function populateFilters() {
  const target = $("target-date");
  const previous = target.value;
  const dates = [...new Set(state.runs.map((run) => run.target_date))].sort().reverse();
  target.replaceChildren();
  for (const date of dates) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = date;
    target.append(option);
  }
  if (dates.includes(previous)) target.value = previous;
  const markets = [...new Set(state.runs.map((run) => run.market))];
  const market = $("market");
  market.replaceChildren();
  for (const name of markets.length ? markets : ["TSE"]) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name === "TSE" ? "東京証券取引所" : name;
    market.append(option);
  }
}

function inFilter(values) {
  return `in.(${values.map((value) => `"${String(value).replaceAll('"', '')}"`).join(",")})`;
}

async function loadSelectedRun() {
  const selected = selectRun(state.runs, $("target-date").value, $("market").value);
  state.selectedRun = selected;
  if (!selected) {
    state.candidates = [];
    state.decisions = [];
    state.orders = [];
    state.audits = [];
    renderDashboard();
    return;
  }
  setMessage("データを読み込んでいます…");
  const candidates = await query("candidates", {
    select: "candidate_id,run_id,candidate_hash,instrument_code,instrument_name,direction,current_price,suggested_quantity,score,reason,assumed_risk,status,decision_eligible,candidate_json,generated_at,expires_at",
    run_id: `eq.${selected.run_id}`,
    order: "score.desc.nullslast,generated_at.desc",
  });
  const ids = candidates.map((item) => item.candidate_id);
  const [decisions, orders, audits] = ids.length ? await Promise.all([
    query("candidate_decisions", {
      select: "decision_id,candidate_id,previous_status,decision,event_type,reason,decided_at,outcome",
      candidate_id: inFilter(ids),
      order: "decided_at.desc",
      limit: "500",
    }),
    query("paper_orders", {
      select: "order_id,candidate_id,environment,side,quantity,reference_price,status,created_at,cancelled_at",
      candidate_id: inFilter(ids),
      order: "created_at.desc",
      limit: "500",
    }),
    query("audit_events", {
      select: "event_id,event_type,aggregate_type,aggregate_id,payload,created_at",
      aggregate_id: inFilter(ids),
      order: "created_at.desc",
      limit: "100",
    }),
  ]) : [[], [], []];
  state.candidates = candidates;
  state.decisions = decisions;
  state.orders = orders;
  state.audits = audits;
  renderDashboard();
  setMessage("");
  $("last-updated").textContent = `更新 ${formatDate(new Date().toISOString())}`;
}

function textNode(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function emptyNode(text) {
  return textNode("div", text, "empty-state");
}

function renderRunSummary() {
  const run = state.selectedRun;
  $("run-status").textContent = run ? statusLabel(run.status) : "結果なし";
  $("run-finished").textContent = run ? formatDate(run.finished_at) : "—";
  $("candidate-count").textContent = run ? formatNumber(run.candidate_count, 0) : "0";
  $("loaded-count").textContent = run ? formatNumber(run.loaded_record_count, 0) : "0";
  $("quality-status").textContent = run ? statusLabel(run.quality_status) : "—";
  $("run-version").textContent = run?.code_version ? `Code ${run.code_version.slice(0, 12)}` : "—";
}

function renderCandidates() {
  const container = $("candidate-list");
  container.replaceChildren();
  if (!state.candidates.length) {
    container.append(emptyNode("この条件の取引候補はありません。"));
    return;
  }
  const decisions = latestDecisionByCandidate(state.decisions);
  const orders = activeOrderByCandidate(state.orders);
  for (const item of state.candidates) {
    const latest = decisions.get(item.candidate_id);
    const activeOrder = orders.get(item.candidate_id);
    const card = document.createElement("article");
    card.className = "candidate-card";
    const top = document.createElement("div");
    top.className = "candidate-top";
    const identity = document.createElement("div");
    identity.className = "candidate-identity";
    identity.append(textNode("span", item.instrument_code, "candidate-code"));
    const name = textNode("h3", item.instrument_name);
    name.append(textNode("small", item.direction === "buy" ? "買い候補" : "売り候補"));
    identity.append(name);
    top.append(identity, textNode("span", item.score == null ? "—" : formatNumber(item.score), "score-badge"));

    const priceRow = document.createElement("div");
    priceRow.className = "candidate-price-row";
    priceRow.append(textNode("strong", formatYen(item.current_price)));
    const quote = document.createElement("a");
    quote.className = "external-link";
    quote.textContent = "企業情報を確認 ↗";
    quote.href = quoteUrl(item.instrument_code);
    quote.target = "_blank";
    quote.rel = "noopener noreferrer";
    priceRow.append(quote);

    const details = document.createElement("dl");
    details.className = "candidate-details";
    for (const [label, value] of [["判断理由", item.reason], ["想定リスク", item.assumed_risk]]) {
      const block = document.createElement("div");
      block.append(textNode("dt", label), textNode("dd", value));
      details.append(block);
    }

    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    meta.append(textNode("span", `生成 ${formatDate(item.generated_at)}`));
    const status = textNode("span", statusLabel(item.status), `candidate-state ${item.status}`);
    meta.append(status);
    card.append(top, priceRow, details, meta);
    if (latest) card.append(textNode("small", `最新判断: ${latest.reason}（${formatDate(latest.decided_at)}）`, "muted"));
    if (activeOrder) card.append(textNode("small", `ペーパー注文: ${formatNumber(activeOrder.quantity, 0)}株 / ${formatYen(activeOrder.reference_price)}`, "muted"));

    const eligible = Boolean(state.selectedRun?.decision_eligible && item.decision_eligible)
      && item.status !== "expired" && Date.parse(item.expires_at) > Date.now();
    const actions = document.createElement("div");
    actions.className = "candidate-actions";
    for (const [decision, label] of [["approved", "採用する"], ["rejected", "見送る"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `decision-button ${decision === "approved" ? "approve" : ""}`;
      button.textContent = item.status === decision ? `${label}（記録済み）` : label;
      button.disabled = !eligible || item.status === decision;
      button.addEventListener("click", () => openDecision(item, decision));
      actions.append(button);
    }
    card.append(actions);
    if (!eligible) card.append(textNode("small", "この候補は判断操作の対象外です。", "muted"));
    container.append(card);
  }
}

function renderDecisionHistory() {
  const body = $("decision-history");
  body.replaceChildren();
  const names = new Map(state.candidates.map((item) => [item.candidate_id, `${item.instrument_code} ${item.instrument_name}`]));
  for (const item of state.decisions) {
    const row = document.createElement("tr");
    for (const value of [formatDate(item.decided_at), names.get(item.candidate_id) || item.candidate_id, statusLabel(item.decision), item.reason]) {
      row.append(textNode("td", value));
    }
    body.append(row);
  }
  if (!state.decisions.length) {
    const row = document.createElement("tr");
    const cell = textNode("td", "判断履歴はありません。", "muted");
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
  }
}

function renderOrders() {
  const container = $("paper-orders");
  container.replaceChildren();
  const names = new Map(state.candidates.map((item) => [item.candidate_id, `${item.instrument_code} ${item.instrument_name}`]));
  for (const item of state.orders) {
    const article = document.createElement("article");
    article.className = "order-item";
    const header = document.createElement("header");
    header.append(textNode("strong", names.get(item.candidate_id) || item.candidate_id), textNode("span", item.status === "created" ? "有効" : "取消済み", `candidate-state ${item.status === "created" ? "approved" : "rejected"}`));
    article.append(header, textNode("span", `${formatNumber(item.quantity, 0)}株 · ${formatYen(item.reference_price)}`), textNode("small", formatDate(item.created_at)));
    container.append(article);
  }
  if (!state.orders.length) container.append(textNode("p", "ペーパー注文はありません。", "muted"));
}

function renderAudits() {
  const container = $("audit-events");
  container.replaceChildren();
  const labels = {
    decision_recorded: "判断を記録",
    decision_corrected: "判断を訂正",
    paper_order_created: "ペーパー注文を作成",
    paper_order_cancelled: "ペーパー注文を取消",
  };
  for (const item of state.audits) {
    const article = document.createElement("article");
    article.className = "audit-item";
    const header = document.createElement("header");
    header.append(textNode("strong", labels[item.event_type] || item.event_type), textNode("small", formatDate(item.created_at)));
    article.append(header, textNode("span", item.aggregate_id));
    if (item.payload?.reason) article.append(textNode("small", item.payload.reason));
    container.append(article);
  }
  if (!state.audits.length) container.append(textNode("p", "監査履歴はありません。", "muted"));
}

function renderDashboard() {
  renderRunSummary();
  renderCandidates();
  renderDecisionHistory();
  renderOrders();
  renderAudits();
}

function openDecision(item, decision) {
  $("decision-candidate-id").value = item.candidate_id;
  $("decision-value").value = decision;
  $("decision-title").textContent = decision === "approved" ? "候補を採用する" : "候補を見送る";
  $("decision-description").textContent = `${item.instrument_code} ${item.instrument_name} · ${formatYen(item.current_price)}`;
  $("decision-reason").value = decision === "approved" ? "候補内容と想定リスクを確認して採用" : "想定リスクを確認し今回は見送り";
  $("decision-message").textContent = "";
  $("decision-dialog").showModal();
  $("decision-reason").focus();
}

async function submitDecision(event) {
  event.preventDefault();
  if (state.decisionPending) return;
  const candidateId = $("decision-candidate-id").value;
  const decision = $("decision-value").value;
  const reason = $("decision-reason").value.trim();
  const candidate = state.candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate || !reason) {
    $("decision-message").textContent = "判断理由を入力してください。";
    return;
  }
  state.decisionPending = true;
  $("decision-submit").disabled = true;
  $("decision-submit").textContent = "記録中…";
  try {
    await businessRequest("/rpc/record_candidate_decision", {
      method: "POST",
      body: {
        p_request_id: newRequestId(),
        p_candidate_id: candidate.candidate_id,
        p_candidate_hash: candidate.candidate_hash,
        p_decision: decision,
        p_reason: reason,
      },
    });
    $("decision-dialog").close();
    setMessage("判断を安全に記録しました。", "success");
    await loadSelectedRun();
  } catch (error) {
    $("decision-message").textContent = error.status ? businessErrorMessage(error.status) : error.message;
  } finally {
    state.decisionPending = false;
    $("decision-submit").disabled = false;
    $("decision-submit").textContent = "記録する";
  }
}

async function enterDashboard() {
  showOnly("boot-screen");
  await validateUser();
  await loadProfileAndRuns();
  $("session-user").textContent = state.profile.display_name || state.user.email || "ログイン中";
  populateFilters();
  showOnly("app-screen");
  await loadSelectedRun();
}

async function refreshAll() {
  const button = $("refresh-button");
  button.disabled = true;
  setMessage("最新情報を確認しています…");
  try {
    await loadProfileAndRuns();
    populateFilters();
    await loadSelectedRun();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  setConnection(navigator.onLine);
  window.addEventListener("online", () => setConnection(true));
  window.addEventListener("offline", () => setConnection(false));
  if (!configReady()) {
    showOnly("login-screen");
    $("login-message").textContent = "公開用設定が未完了です。SUPABASE_PUBLISHABLE_KEYを登録してください。";
    $("login-button").disabled = true;
    return;
  }
  state.session = readStoredSession();
  if (!state.session) {
    showOnly("login-screen");
    return;
  }
  try {
    await ensureSession();
    await enterDashboard();
  } catch {
    await expireSession();
  }
}

$("login-form").addEventListener("submit", handleLogin);
$("logout-button").addEventListener("click", signOut);
$("refresh-button").addEventListener("click", refreshAll);
$("apply-filter").addEventListener("click", () => loadSelectedRun().catch((error) => setMessage(error.message, "error")));
$("decision-form").addEventListener("submit", submitDecision);
$("decision-cancel").addEventListener("click", () => $("decision-dialog").close());
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !state.session) showOnly("login-screen");
});

boot();
