export function marketDate(value, market = "TSE") {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: market === "TSE" ? "Asia/Tokyo" : "America/New_York", year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function adjustedQuantity(order, code, valuedOn, market, events) {
  let factor = 1;
  const acquired = marketDate(order.created_at, market);
  for (const event of events) {
    if (event.market === market && event.instrument_code === code && acquired < event.price_effective_date && event.price_effective_date <= valuedOn) factor *= Number(event.numerator) / Number(event.denominator);
  }
  const quantity = Number(order.quantity) * factor;
  if (!Number.isSafeInteger(quantity)) throw new Error("株式併合の端株処理を確認してください");
  return {quantity, factor};
}

export function earningsLabel(value, asOf) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= asOf
    ? `次回決算 ${value}` : "次回決算 未確認（公式IRの確認が必要）";
}
