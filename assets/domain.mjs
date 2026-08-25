const STATUS_LABELS = Object.freeze({
  succeeded: "完了",
  degraded: "注意あり",
  skipped: "対象なし",
  failed: "失敗",
  pending: "未判断",
  approved: "採用",
  rejected: "見送り",
  expired: "期限切れ",
});

export function statusLabel(value) {
  return STATUS_LABELS[value] || String(value || "不明");
}

export function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(parsed);
}

export function formatNumber(value, maximumFractionDigits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits }).format(number);
}

export function formatYen(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(number);
}

export function authErrorMessage(status, payload = {}) {
  const detail = String(payload.msg || payload.message || payload.error_description || "").toLowerCase();
  if (status === 429) return "試行回数が上限に達しました。しばらく待ってから再試行してください。";
  if (detail.includes("email not confirmed")) return "管理者設定を確認してください。";
  if (detail.includes("invalid login") || detail.includes("invalid credentials")) {
    return "ログイン情報を確認してください。";
  }
  if (status === 401 || status === 403) return "このアカウントは利用できません。";
  if (status >= 500) return "認証サービスへ接続できません。時間をおいて再試行してください。";
  return "ログインできませんでした。入力内容と通信状態を確認してください。";
}

export function businessErrorMessage(status) {
  if (status === 401 || status === 403) return "セッションが終了しました。再度ログインしてください。";
  if (status === 409) return "候補の状態が更新されています。再読み込みして確認してください。";
  if (status === 429) return "処理が混み合っています。少し待って再試行してください。";
  return "データを取得できませんでした。通信状態を確認してください。";
}

export function isExpired(session, nowSeconds = Date.now() / 1000) {
  return !session?.access_token || Number(session.expires_at || 0) <= nowSeconds + 30;
}

export function selectRun(runs, targetDate, market) {
  const filtered = runs.filter((run) => (
    (!targetDate || run.target_date === targetDate)
    && (!market || run.market === market)
  ));
  return filtered.sort((left, right) => (
    Date.parse(right.finished_at || 0) - Date.parse(left.finished_at || 0)
  ))[0] || null;
}

export function latestDecisionByCandidate(decisions) {
  const latest = new Map();
  for (const item of decisions) {
    const current = latest.get(item.candidate_id);
    if (!current || Date.parse(item.decided_at) > Date.parse(current.decided_at)) {
      latest.set(item.candidate_id, item);
    }
  }
  return latest;
}

export function activeOrderByCandidate(orders) {
  return new Map(
    orders
      .filter((item) => item.status === "created")
      .map((item) => [item.candidate_id, item]),
  );
}

export function safeInstrumentCode(value) {
  const code = String(value || "").trim();
  return /^[0-9A-Za-z.-]{1,20}$/.test(code) ? code : "";
}

export function quoteUrl(value) {
  const code = safeInstrumentCode(value);
  if (!code) return "";
  const symbol = code.replace(/\.T$/i, "");
  return `https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}.T`;
}

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
