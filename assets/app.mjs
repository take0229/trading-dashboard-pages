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
const DEFAULT_TAKE_PROFIT_RATE = 0.25;
const DEFAULT_STOP_LOSS_RATE = -0.20;
const config = window.TRADING_DASHBOARD_CONFIG || {};
const state = {
  session: null,
  user: null,
  profile: null,
  runs: [],
  selectedRun: null,
  candidates: [],
  allCandidates: [],
  decisions: [],
  orders: [],
  exits: [],
  portfolioSettings: null,
  positionPrices: [],
  positionRefresh: null,
  dataWarnings: [],
  refreshTimer: null,
  dashboardRefreshTimer: null,
  dashboardRefreshing: false,
  lockTimer: null,
  decisionPending: false,
  exitPending: false,
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
  state.allCandidates = [];
  state.decisions = [];
  state.orders = [];
  state.exits = [];
  state.portfolioSettings = null;
  state.positionPrices = [];
  state.positionRefresh = null;
  state.dataWarnings = [];
  if (state.dashboardRefreshTimer) window.clearInterval(state.dashboardRefreshTimer);
  state.dashboardRefreshTimer = null;
  $("candidate-list").replaceChildren();
  $("positions").replaceChildren();
  $("trade-history").replaceChildren();
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
      select: "run_id,target_date,market,status,quality_status,started_at,finished_at,loaded_record_count,candidate_count,decision_eligible,code_version,result_json",
      order: "finished_at.desc",
      limit: "1000",
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
  setMessage("データを読み込んでいます…");
  const results = await Promise.allSettled([
    selected ? query("candidates", {
      select: "candidate_id,run_id,candidate_hash,instrument_code,instrument_name,direction,current_price,suggested_quantity,score,reason,assumed_risk,status,decision_eligible,candidate_json,generated_at,expires_at",
      run_id: `eq.${selected.run_id}`,
      order: "score.desc.nullslast,generated_at.desc",
    }) : [],
    query("candidates", {
      select: "candidate_id,run_id,candidate_hash,instrument_code,instrument_name,direction,current_price,suggested_quantity,score,reason,assumed_risk,status,decision_eligible,candidate_json,generated_at,expires_at",
      order: "generated_at.desc",
      limit: "1000",
    }),
    query("candidate_decisions", {
      select: "decision_id,request_id,candidate_id,candidate_hash,previous_status,decision,event_type,reason,candidate_snapshot,outcome,decided_at",
      order: "decided_at.desc",
      limit: "1000",
    }),
    query("paper_orders", {
      select: "order_id,decision_id,candidate_id,environment,side,quantity,reference_price,status,created_at,cancelled_at,closed_at",
      order: "created_at.desc",
      limit: "1000",
    }),
    query("paper_exits", {
      select: "exit_id,request_id,instrument_code,instrument_name,action,quantity,exit_price,valuation_date,cost_basis,proceeds,realized_profit_loss,reason,outcome,created_at",
      order: "created_at.desc",
      limit: "1000",
    }),
    query("paper_portfolio_settings", { select: "initial_cash,take_profit_rate,stop_loss_rate,updated_at", limit: "1" }),
    query("paper_position_prices", {
      select: "instrument_code,price_date,close_price,run_id,recorded_at",
      order: "price_date.desc,instrument_code.asc",
      limit: "5000",
    }),
    query("paper_position_refresh_state", {
      select: "target_date,run_id,input_position_count,new_position_count,new_codes,updated_count,missing_codes,error,recorded_at",
      limit: "1",
    }),
  ]);
  if (results[0].status === "rejected") {
    const detail = results[0].reason?.message || "再読み込みしてください。";
    throw new Error(`選択した対象日の候補データを取得できませんでした。${detail}`);
  }
  const labels = ["候補", "全候補履歴", "判断履歴", "選択履歴", "決済履歴", "初期資金", "保有価格履歴", "価格更新状態"];
  state.dataWarnings = results.flatMap((result, index) => (
    result.status === "rejected" ? [`${labels[index]}を取得できませんでした`] : []
  ));
  const value = (index, fallback) => results[index].status === "fulfilled" ? results[index].value : fallback;
  state.candidates = asArray(value(0, []));
  state.allCandidates = asArray(value(1, state.candidates));
  if (!state.allCandidates.length && state.candidates.length) state.allCandidates = [...state.candidates];
  state.decisions = asArray(value(2, []));
  state.orders = asArray(value(3, []));
  state.exits = asArray(value(4, []));
  state.portfolioSettings = asArray(value(5, []))[0] || null;
  state.positionPrices = asArray(value(6, []));
  state.positionRefresh = asArray(value(7, []))[0] || null;
  renderDashboard();
  setMessage(
    state.dataWarnings.length ? `候補を表示しました。一部の履歴は取得できませんでした：${state.dataWarnings.join("、")}` : "",
    state.dataWarnings.length ? "warning" : "",
  );
  $("last-updated").textContent = `更新 ${formatDate(new Date().toISOString())}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatPercentValue(rate) {
  return (Number(rate || 0) * 100).toFixed(1).replace(/\.0$/, "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  const result = asObject(run?.result_json);
  $("run-status").textContent = run ? statusLabel(run.status) : "結果なし";
  $("run-status").className = `candidate-state ${run?.status || ""}`;
  $("run-date").textContent = run ? `${run.target_date} / ${run.market}` : "—";
  const qualityLabels = { passed: "品質検査通過", warning: "品質警告あり", failed: "品質検査失敗", not_evaluated: "品質未評価" };
  const quality = qualityLabels[run?.quality_status] || statusLabel(run?.quality_status);
  const pipeline = result.pipeline_version || result.schema_version || "legacy";
  $("run-description").textContent = run
    ? `${pipeline} · ${formatNumber(run.loaded_record_count, 0)}件の価格データから${formatNumber(run.candidate_count, 0)}件の候補を生成しました。データ品質: ${quality}。`
    : "表示できる分析結果がありません。";
  const selectedCount = state.candidates.filter((item) => item.status === "approved").length;
  $("candidate-count").textContent = `候補 ${run?.candidate_count || 0}件 / 選択 ${selectedCount}件`;
  $("run-id").textContent = run ? `RUN ${run.run_id}` : "";
  const providers = asObject(result.provider_versions);
  $("data-source-note").textContent = providers.yfinance
    ? `yfinance ${providers.yfinance}で取得したデータによる分析・ペーパーシミュレーションです。投資助言ではなく、実注文は送信されません。`
    : "保存済みデータによる分析・ペーパーシミュレーションです。投資助言ではなく、実注文は送信されません。";
  renderBatchAlerts(asArray(result.warnings), asArray(result.errors));
  renderLatestBatch();
  renderHistoryStatus();
}

function renderHistoryStatus() {
  const summary = `Supabase履歴：分析実行 ${state.runs.length}件 / 候補 ${state.allCandidates.length}件 / 判断 ${state.decisions.length}件 / 選択 ${state.orders.length}件 / 決済 ${state.exits.length}件 / 保有価格 ${state.positionPrices.length}件`;
  $("history-status").textContent = state.dataWarnings.length
    ? `${summary}（一部取得エラーあり）`
    : `${summary}（移行済みデータを表示中）`;
  $("history-status").classList.toggle("warning", state.dataWarnings.length > 0);
}

function renderLatestBatch() {
  const latest = [...state.runs].sort((left, right) => Date.parse(right.finished_at || 0) - Date.parse(left.finished_at || 0))[0];
  $("latest-batch-time").textContent = latest ? formatDate(latest.finished_at) : "実行履歴なし";
  $("latest-batch-target").textContent = latest ? `${statusLabel(latest.status)} · 対象日 ${latest.target_date} / ${latest.market}` : "";
}

function localizeBatchMessage(message) {
  const value = String(message || "");
  let match = value.match(/^Fundamental data was unavailable for (\d+) instrument\(s\)\.$/);
  if (match) return `ファンダメンタルデータを取得できなかった銘柄が${formatNumber(Number(match[1]), 0)}件あります。`;
  match = value.match(/^Target-date coverage is incomplete: (\d+) instrument\(s\) missing\.$/);
  if (match) return `対象日の株価データが不足している銘柄が${formatNumber(Number(match[1]), 0)}件あります。`;
  match = value.match(/^News data was unavailable for (\d+) candidate\(s\);/);
  if (match) return `ニュースを取得できなかった候補が${formatNumber(Number(match[1]), 0)}件あります。ニュースを採点せず分析を継続しました。`;
  match = value.match(/^Held-position target-date prices were unavailable for (\d+) instrument\(s\): (.+)$/);
  if (match) return `保有銘柄${formatNumber(Number(match[1]), 0)}件の対象日株価を取得できませんでした（${match[2]}）。`;
  match = value.match(/^Analysis continued after excluding (\d+) instrument\(s\) with missing target-date data: (.+)\.$/);
  if (match) return `データ品質警告：対象日データが欠落した${formatNumber(Number(match[1]), 0)}銘柄（${match[2]}）を除外して分析を継続しました。`;
  if (value.startsWith("MVP v3 output is research support")) {
    return "この結果は調査支援とペーパートレード専用です。実注文は行われません。";
  }
  return value;
}

function renderBatchAlerts(warnings, errors) {
  const container = $("batch-alerts");
  const list = $("batch-alerts-list");
  const items = [
    ...asArray(warnings).map((message) => ({ type: "warning", message })),
    ...asArray(errors).map((message) => ({ type: "error", message })),
  ];
  container.hidden = items.length === 0;
  list.replaceChildren();
  if (!items.length) return;
  $("batch-alerts-title").textContent = errors.length ? "バッチ処理の警告・エラー" : "バッチ処理の警告";
  $("batch-alerts-count").textContent = `${items.length}件`;
  for (const item of items) {
    const row = document.createElement("li");
    row.className = item.type;
    row.append(textNode("strong", item.type === "error" ? "エラー" : "警告"), textNode("span", localizeBatchMessage(item.message)));
    list.append(row);
  }
}

function buildPaperPortfolio() {
  const initialCash = Number(state.portfolioSettings?.initial_cash || 0);
  const takeProfitRate = Number(state.portfolioSettings?.take_profit_rate ?? DEFAULT_TAKE_PROFIT_RATE);
  const stopLossRate = Number(state.portfolioSettings?.stop_loss_rate ?? DEFAULT_STOP_LOSS_RATE);
  const candidates = new Map(state.allCandidates.map((item) => [item.candidate_id, item]));
  const decisions = new Map(state.decisions.map((item) => [item.decision_id, item]));
  const latestPrices = new Map();
  for (const price of state.positionPrices) {
    if (!latestPrices.has(price.instrument_code)) latestPrices.set(price.instrument_code, price);
  }
  const positionsByCode = new Map();
  for (const order of state.orders.filter((item) => item.status === "created")) {
    const candidate = candidates.get(order.candidate_id) || {};
    const code = candidate.instrument_code || order.candidate_id;
    const current = positionsByCode.get(code) || {
      instrument_code: code,
      instrument_name: candidate.instrument_name || code,
      quantity: 0,
      invested_amount: 0,
      acquisition_records: [],
    };
    const quantity = Number(order.quantity || 0);
    const referencePrice = Number(order.reference_price || 0);
    const decision = decisions.get(order.decision_id) || {};
    const snapshot = decision.candidate_snapshot || candidate.candidate_json || {};
    current.quantity += quantity;
    current.invested_amount += quantity * referencePrice;
    current.acquisition_records.push({
      selected_at: order.created_at,
      quantity,
      reference_price: referencePrice,
      selection_reason: decision.reason,
      screening_reason: snapshot.reason || candidate.reason,
      assumed_risk: snapshot.assumed_risk || candidate.assumed_risk,
      total_score: snapshot.total_score ?? candidate.score,
      fundamental_score: snapshot.fundamental_analysis?.score,
      technical_score: snapshot.technical_analysis?.score,
      run_id: candidate.run_id,
      candidate_id: candidate.candidate_id,
      fundamental_criteria_version: snapshot.fundamental_analysis?.criteria_version,
      technical_version: snapshot.technical_analysis?.version,
      news_analysis_version: snapshot.news_analysis?.version,
    });
    positionsByCode.set(code, current);
  }
  const positions = [...positionsByCode.values()].map((item) => {
    const price = latestPrices.get(item.instrument_code);
    const fallbackCandidate = state.allCandidates.find((candidate) => candidate.instrument_code === item.instrument_code);
    const currentPrice = Number(price?.close_price || fallbackCandidate?.current_price || (item.invested_amount / item.quantity) || 0);
    const averageCost = item.quantity ? item.invested_amount / item.quantity : 0;
    const marketValue = item.quantity * currentPrice;
    const profit = marketValue - item.invested_amount;
    const returnRate = item.invested_amount ? profit / item.invested_amount : 0;
    const signal = !price ? "unavailable" : returnRate >= takeProfitRate ? "take_profit" : returnRate <= stopLossRate ? "stop_loss" : "hold";
    return {
      ...item,
      average_cost: averageCost,
      current_price: currentPrice,
      market_value: marketValue,
      unrealized_profit_loss: profit,
      unrealized_return_rate: returnRate,
      valuation_date: price?.price_date || null,
      take_profit_price: averageCost * (1 + takeProfitRate),
      stop_loss_price: averageCost * (1 + stopLossRate),
      take_profit_rate: takeProfitRate,
      stop_loss_rate: stopLossRate,
      exit_signal: signal,
    };
  }).sort((left, right) => left.instrument_code.localeCompare(right.instrument_code));
  const investedAmount = positions.reduce((sum, item) => sum + item.invested_amount, 0);
  const marketValue = positions.reduce((sum, item) => sum + item.market_value, 0);
  const unrealizedProfit = marketValue - investedAmount;
  const realizedProfit = state.exits.reduce((sum, item) => sum + Number(item.realized_profit_loss || 0), 0);
  const cashBalance = initialCash - investedAmount + realizedProfit;
  const totalProfit = realizedProfit + unrealizedProfit;
  return {
    initial_cash: initialCash,
    take_profit_rate: takeProfitRate,
    stop_loss_rate: stopLossRate,
    cash_balance: cashBalance,
    invested_amount: investedAmount,
    market_value: marketValue,
    total_assets: cashBalance + marketValue,
    unrealized_profit_loss: unrealizedProfit,
    realized_profit_loss: realizedProfit,
    total_profit_loss: totalProfit,
    total_return_rate: initialCash ? totalProfit / initialCash : 0,
    positions,
  };
}

function renderPortfolio() {
  const portfolio = buildPaperPortfolio();
  if (!$("exit-rule-form").contains(document.activeElement)) {
    $("take-profit-percent").value = String(portfolio.take_profit_rate * 100);
    $("stop-loss-percent").value = String(Math.abs(portfolio.stop_loss_rate * 100));
  }
  $("paper-total-assets").textContent = formatYen(portfolio.total_assets);
  $("paper-initial-cash").textContent = `初期資金 ${formatYen(portfolio.initial_cash)}`;
  $("paper-cash").textContent = formatYen(portfolio.cash_balance);
  $("paper-market-value").textContent = formatYen(portfolio.market_value);
  const valuationDate = state.positionRefresh?.target_date || portfolio.positions[0]?.valuation_date || "未取得";
  $("paper-invested").textContent = `取得原価 ${formatYen(portfolio.invested_amount)} · 評価日 ${valuationDate}`;
  const profit = portfolio.total_profit_loss;
  $("paper-profit").textContent = `${profit > 0 ? "+" : ""}${formatYen(profit)}`;
  $("paper-profit").className = profit > 0 ? "positive" : profit < 0 ? "negative" : "";
  const rate = portfolio.total_return_rate * 100;
  $("paper-return-rate").textContent = `実現 ${formatYen(portfolio.realized_profit_loss)} / 評価 ${formatYen(portfolio.unrealized_profit_loss)} / 総資産比 ${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
  renderPositions(portfolio.positions);
  renderTrades(state.orders, state.exits, new Map(state.allCandidates.map((item) => [item.candidate_id, item])));
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
  const latestOrders = new Map();
  for (const order of state.orders) {
    if (!latestOrders.has(order.candidate_id)) latestOrders.set(order.candidate_id, order);
  }
  for (const item of state.candidates) {
    const latest = decisions.get(item.candidate_id);
    const activeOrder = orders.get(item.candidate_id);
    const latestOrder = latestOrders.get(item.candidate_id);
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
    priceRow.append(renderStockLinks(item.instrument_code));

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
    card.append(top, priceRow, details);
    const payload = asObject(item.candidate_json);
    if (payload.fundamental_analysis) card.append(renderFundamentalAnalysis(payload.fundamental_analysis));
    if (payload.news_analysis) card.append(renderNewsAnalysis(payload.news_analysis));
    if (payload.technical_analysis) card.append(renderTechnicalAnalysis(payload.technical_analysis));
    card.append(meta);
    if (latest) card.append(textNode("small", `最新判断: ${latest.reason}（${formatDate(latest.decided_at)}）`, "muted"));
    if (activeOrder) card.append(textNode("small", `ペーパー注文: ${formatNumber(activeOrder.quantity, 0)}株 / ${formatYen(activeOrder.reference_price)}`, "muted"));
    if (!activeOrder && latestOrder?.status === "closed") card.append(textNode("small", "ペーパー決済済み", "muted"));
    if (activeOrder) card.append(renderYahooPaperGuide(item, activeOrder));

    const eligible = Boolean(state.selectedRun?.decision_eligible && item.decision_eligible)
      && item.status !== "expired" && latestOrder?.status !== "closed" && Date.parse(item.expires_at) > Date.now();
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

function renderStockLinks(instrumentCode) {
  const links = document.createElement("nav");
  links.className = "stock-information-links";
  links.setAttribute("aria-label", `${instrumentCode}の外部株式情報`);
  const code = String(instrumentCode || "").replace(/\.T$/i, "");
  for (const [label, href] of [
    ["Yahoo!ファイナンス", quoteUrl(code)],
    ["株探で深掘り", `https://kabutan.jp/stock/?code=${encodeURIComponent(code)}`],
  ]) {
    const link = textNode("a", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    links.append(link);
  }
  return links;
}

function renderYahooPaperGuide(item, order) {
  const guide = document.createElement("div");
  guide.className = "yahoo-paper-guide";
  guide.append(
    textNode("p", `Yahoo!ファイナンス「ペーパートレード」登録値：${formatNumber(order.quantity, 0)}株 / 購入価格 ${formatYen(order.reference_price)}`),
  );
  const link = textNode("a", "Yahoo!ポートフォリオに登録する ↗");
  link.href = quoteUrl(item.instrument_code);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  guide.append(link, textNode("small", "Yahoo! JAPANへログイン後、ポートフォリオのペーパートレードへ保有数と購入価格を入力してください。"));
  return guide;
}

function renderMetricRows(entries) {
  const rows = document.createElement("div");
  rows.className = "analysis-metrics";
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.append(textNode("span", label), textNode("strong", value));
    rows.append(row);
  }
  return rows;
}

function renderFundamentalAnalysis(analysis) {
  analysis = asObject(analysis);
  const details = document.createElement("details");
  details.className = "candidate-analysis";
  const score = analysis.score == null ? "算定不能" : `${formatNumber(analysis.score)} / ${formatNumber(analysis.max_score)}点`;
  details.append(textNode("summary", `ファンダメンタル ${score} · 取得率 ${Math.round(Number(analysis.coverage_ratio || 0) * 100)}%`));
  details.append(textNode("p", `${analysis.fiscal_period ? `会計基準日 ${analysis.fiscal_period}` : "会計基準日 不明"} · ${analysis.next_earnings_date ? `次回決算 ${analysis.next_earnings_date}` : "次回決算 不明"}`, "analysis-note"));
  const entries = Object.values(asObject(analysis.metrics))
    .filter((metric) => metric && typeof metric === "object")
    .filter((metric) => metric.unit !== "currency")
    .map((metric) => {
      const value = metric.value == null ? "不明" : metric.unit === "percent"
        ? `${formatNumber(metric.value)}%` : metric.unit === "ratio" ? `${formatNumber(metric.value)}倍` : formatNumber(metric.value);
      const points = metric.max_points === 0 ? " · 参考" : metric.points == null ? "" : ` · ${metric.points}/${metric.max_points}`;
      return [metric.label || "指標", `${value}${points}`];
    });
  details.append(renderMetricRows(entries));
  const missing = (analysis.missing_fields || []).join(", ");
  if (missing) details.append(textNode("small", `欠損: ${missing}`, "muted"));
  return details;
}

function renderNewsAnalysis(analysis) {
  analysis = asObject(analysis);
  const details = document.createElement("details");
  details.className = "candidate-analysis news-analysis";
  const counts = asObject(analysis.sentiment_counts);
  details.append(textNode("summary", `ニュース注意情報 ${analysis.article_count || 0}件 · ポジティブ${counts.positive || 0} / ネガティブ${counts.negative || 0}`));
  if (analysis.critical_review) details.append(textNode("div", "重大イベント候補あり：人間による確認が必要です", "critical-review"));
  const list = document.createElement("div");
  list.className = "news-list";
  for (const article of asArray(analysis.articles).filter((item) => item && typeof item === "object")) {
    const item = document.createElement("article");
    let heading = textNode("strong", article.title || "タイトル不明");
    if (/^https:\/\//.test(String(article.url || ""))) {
      heading = textNode("a", article.title || "ニュースを開く");
      heading.href = article.url;
      heading.target = "_blank";
      heading.rel = "noopener noreferrer";
    }
    item.append(heading, textNode("p", `${article.publisher || "配信元不明"} · ${formatDate(article.published_at)} · ${article.category || "分類なし"} · ${article.sentiment || "判定不能"}`));
    if (article.reason) item.append(textNode("small", article.reason));
    list.append(item);
  }
  if (!list.childElementCount) list.append(textNode("p", analysis.error ? `ニュースを取得できませんでした: ${analysis.error}` : "対象期間のニュースはありません。"));
  details.append(list);
  return details;
}

function renderTechnicalAnalysis(analysis) {
  analysis = asObject(analysis);
  const details = document.createElement("details");
  details.className = "candidate-analysis";
  details.append(textNode("summary", `テクニカル ${formatNumber(analysis.score)} / ${formatNumber(analysis.max_score)}点 · ${analysis.eligible ? "買いタイミング通過" : "未通過"}`));
  const value = asObject(analysis.indicators);
  details.append(renderMetricRows([
    ["移動平均 20日 / 60日", `${formatNumber(value.ma20)} / ${formatNumber(value.ma60)}`],
    ["RSI(14)", formatNumber(value.rsi14)],
    ["MACD / Signal", `${formatNumber(value.macd_12_26)} / ${formatNumber(value.macd_signal_9)}`],
    ["MACD Histogram", formatNumber(value.macd_histogram)],
    ["20日モメンタム", `${formatNumber(value.momentum20_percent)}%`],
    ["出来高倍率", `${formatNumber(value.volume_ratio20)}倍`],
  ]));
  return details;
}

function renderPositions(positions) {
  const container = $("positions");
  container.replaceChildren();
  positions = asArray(positions);
  if (!positions.length) {
    container.append(emptyNode("現在の保有銘柄はありません。"));
    return;
  }
  for (const item of positions) {
    const row = document.createElement("article");
    row.className = "position-item";
    const header = document.createElement("header");
    header.append(textNode("div", `${item.instrument_code} · ${formatNumber(item.quantity, 0)}株`, "candidate-code"), textNode("strong", item.instrument_name), textNode("strong", formatYen(item.market_value), "position-value"));
    const rate = item.unrealized_return_rate * 100;
    const profit = item.unrealized_profit_loss;
    const summary = textNode("p", `平均 ${formatYen(item.average_cost)} / 現在 ${formatYen(item.current_price)} / 評価損益 ${profit > 0 ? "+" : ""}${formatYen(profit)}（取得額比 ${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%） / 評価日 ${item.valuation_date || "未取得"}`);
    summary.className = profit > 0 ? "positive" : profit < 0 ? "negative" : "";
    const signalLabels = {
      take_profit: `利確シグナル（+${formatPercentValue(item.take_profit_rate)}%以上）`,
      stop_loss: `損切りシグナル（-${formatPercentValue(Math.abs(item.stop_loss_rate))}%以下）`,
      hold: "保有継続",
      unavailable: "判定不可（保存済み株価なし）",
    };
    const signal = document.createElement("div");
    signal.className = `exit-signal ${item.exit_signal}`;
    signal.append(
      textNode("strong", signalLabels[item.exit_signal]),
      textNode("small", `利確目安 ${formatYen(item.take_profit_price)} / 損切り目安 ${formatYen(item.stop_loss_price)}`),
    );
    if (["take_profit", "stop_loss"].includes(item.exit_signal)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `exit-button ${item.exit_signal}`;
      button.textContent = item.exit_signal === "take_profit" ? "手動で利確する" : "手動で損切りする";
      button.disabled = state.exitPending;
      button.addEventListener("click", () => submitPaperExit(item));
      signal.append(button);
    }
    row.append(header, summary, signal, renderStockLinks(item.instrument_code), renderAcquisitionReasons(item.acquisition_records));
    container.append(row);
  }
}

function renderAcquisitionReasons(records) {
  records = asArray(records);
  const details = document.createElement("details");
  details.className = "acquisition-reasons";
  details.append(textNode("summary", `取得時の理由・再現条件（${records.length}件）`));
  for (const record of records) {
    const article = document.createElement("article");
    article.append(
      textNode("strong", `${formatDate(record.selected_at)} · ${formatNumber(record.quantity, 0)}株 · ${formatYen(record.reference_price)}`),
      textNode("p", `選択理由：${record.selection_reason || "記録なし"}`),
      textNode("p", `候補根拠：${record.screening_reason || "記録なし"}`),
      textNode("p", `想定リスク：${record.assumed_risk || "記録なし"}`),
    );
    const scores = [
      record.total_score != null ? `総合 ${record.total_score}` : null,
      record.fundamental_score != null ? `ファンダメンタル ${record.fundamental_score}` : null,
      record.technical_score != null ? `テクニカル ${record.technical_score}` : null,
    ].filter(Boolean).join(" / ");
    article.append(textNode("small", `選択時スコア：${scores || "記録なし"}`));
    const versions = [record.fundamental_criteria_version, record.technical_version, record.news_analysis_version].filter(Boolean).join(" / ");
    article.append(textNode("small", `再現識別：Run ${record.run_id || "不明"} / Candidate ${record.candidate_id || "不明"}${versions ? ` / Version ${versions}` : ""}`));
    details.append(article);
  }
  return details;
}

function renderTrades(orders, exits, candidates) {
  orders = asArray(orders);
  exits = asArray(exits);
  const body = $("trade-history");
  body.replaceChildren();
  const rows = [
    ...orders.map((item) => ({ kind: "order", created_at: item.created_at, item })),
    ...exits.map((item) => ({ kind: "exit", created_at: item.created_at, item })),
  ].sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0));
  for (const entry of rows) {
    const item = entry.item;
    if (entry.kind === "exit") {
      const profit = Number(item.realized_profit_loss || 0);
      const values = [
        formatDate(item.created_at),
        `${item.instrument_code} ${item.instrument_name}`,
        item.action === "take_profit" ? "利確" : "損切り",
        `${formatNumber(item.quantity, 0)}株`,
        formatYen(item.exit_price),
        `実現 ${profit > 0 ? "+" : ""}${formatYen(profit)}`,
      ];
      const row = document.createElement("tr");
      for (const value of values) row.append(textNode("td", value));
      body.append(row);
      continue;
    }
    const candidate = candidates.get(item.candidate_id) || {};
    const values = [
      formatDate(item.created_at),
      `${candidate.instrument_code || "—"} ${candidate.instrument_name || item.candidate_id}`,
      item.side === "buy" ? "選択" : "解除",
      `${formatNumber(item.quantity, 0)}株`,
      formatYen(item.reference_price),
      item.status === "created" ? "保有中" : item.status === "closed" ? "決済済み" : "取消済み",
    ];
    const row = document.createElement("tr");
    for (const value of values) row.append(textNode("td", value));
    body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = textNode("td", "ペーパートレードの売買履歴はありません。", "muted");
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }
}

async function submitPaperExit(item) {
  if (state.exitPending || !["take_profit", "stop_loss"].includes(item.exit_signal)) return;
  const label = item.exit_signal === "take_profit" ? "利確" : "損切り";
  const reason = window.prompt(`${item.instrument_code} ${item.instrument_name}を${label}する理由を入力してください。`, `${label}ルールに到達したため手動決済`);
  if (!reason?.trim()) return;
  if (!window.confirm(`${formatNumber(item.quantity, 0)}株を${formatYen(item.current_price)}でペーパー${label}します。実際の注文は送信されません。よろしいですか？`)) return;
  state.exitPending = true;
  renderPortfolio();
  try {
    await businessRequest("/rpc/record_paper_position_exit", {
      method: "POST",
      body: {
        p_request_id: newRequestId(),
        p_instrument_code: item.instrument_code,
        p_action: item.exit_signal,
        p_reason: reason.trim(),
      },
    });
    await loadSelectedRun();
    setMessage(`${item.instrument_code}をペーパー${label}し、実現損益を資産に反映しました。`, "success");
  } catch (error) {
    setMessage(error.status ? businessErrorMessage(error.status) : error.message, "error");
  } finally {
    state.exitPending = false;
    renderPortfolio();
  }
}

async function submitExitRules(event) {
  event.preventDefault();
  const takeProfitPercent = Number($("take-profit-percent").value);
  const stopLossPercent = Number($("stop-loss-percent").value);
  const message = $("exit-rule-message");
  if (!(takeProfitPercent > 0 && takeProfitPercent <= 500)) {
    message.textContent = "利確率は0%超500%以下で入力してください。";
    return;
  }
  if (!(stopLossPercent > 0 && stopLossPercent < 100)) {
    message.textContent = "損切り率は0%超100%未満で入力してください。";
    return;
  }
  const button = $("exit-rule-save");
  button.disabled = true;
  message.textContent = "保存しています…";
  try {
    const result = await businessRequest("/rpc/update_paper_exit_rules", {
      method: "POST",
      body: {
        p_take_profit_rate: takeProfitPercent / 100,
        p_stop_loss_rate: -stopLossPercent / 100,
        p_reason: "ダッシュボードで利確・損切りルールを変更",
      },
    });
    state.portfolioSettings = { ...(state.portfolioSettings || {}), ...(result || {}) };
    await loadSelectedRun();
    message.textContent = `利確 +${takeProfitPercent}%／損切り -${stopLossPercent}%へ変更しました。`;
  } catch (error) {
    message.textContent = error.status ? businessErrorMessage(error.status) : error.message;
  } finally {
    button.disabled = false;
  }
}

function renderDashboard() {
  renderRunSummary();
  renderPortfolio();
  renderCandidates();
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
  startDashboardRefresh();
}

async function refreshAll({ background = false } = {}) {
  if (state.dashboardRefreshing || !state.session) return;
  state.dashboardRefreshing = true;
  const button = $("refresh-button");
  button.disabled = true;
  if (!background) setMessage("最新情報を確認しています…");
  try {
    await loadProfileAndRuns();
    populateFilters();
    await loadSelectedRun();
    $("auto-refresh-status").textContent = `自動更新確認 ${new Date().toLocaleTimeString("ja-JP")}`;
  } catch (error) {
    if (!background) setMessage(error.message, "error");
    $("auto-refresh-status").textContent = `自動更新失敗 ${new Date().toLocaleTimeString("ja-JP")}`;
  } finally {
    button.disabled = false;
    state.dashboardRefreshing = false;
  }
}

function startDashboardRefresh() {
  if (state.dashboardRefreshTimer) window.clearInterval(state.dashboardRefreshTimer);
  state.dashboardRefreshTimer = window.setInterval(() => {
    if (!document.hidden) refreshAll({ background: true });
  }, 30_000);
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
$("refresh-button").addEventListener("click", () => refreshAll());
$("apply-filter").addEventListener("click", () => loadSelectedRun().catch((error) => setMessage(error.message, "error")));
$("decision-form").addEventListener("submit", submitDecision);
$("decision-cancel").addEventListener("click", () => $("decision-dialog").close());
$("exit-rule-form").addEventListener("submit", submitExitRules);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !state.session) showOnly("login-screen");
});

boot();
