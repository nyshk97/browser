// カードの表示と入力の整形。保存する値は crypto-spec.md のカードの節に従う

export const CARD_BRANDS = ["Visa", "Mastercard", "Amex", "JCB", "Diners Club", "Discover", "UnionPay", "Maestro", "Other"];

export function digitsOf(number: string): string {
  return number.replace(/[\s-]/g, "");
}

// 番号の先頭からブランドを推定する（表示用。保存はしない）
export function detectBrand(number: string): string {
  const n = digitsOf(number);
  if (/^4/.test(n)) return "Visa";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^35(2[89]|[3-8])/.test(n)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(n)) return "Diners Club";
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(n)) return "Mastercard";
  if (/^6(011|5)/.test(n)) return "Discover";
  if (/^62/.test(n)) return "UnionPay";
  return "";
}

export function brandOf(card: { brand: string; number: string }): string {
  return card.brand || detectBrand(card.number);
}

// 表示用に 4 桁ずつ区切る（Amex は 4-6-5）
export function formatNumber(number: string): string {
  const n = digitsOf(number);
  if (!/^\d+$/.test(n)) return number;
  const groups = /^3[47]/.test(n) ? [4, 6, 5] : [];
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= n.length) break;
    out.push(n.slice(i, i + g));
    i += g;
  }
  for (; i < n.length; i += 4) out.push(n.slice(i, i + 4));
  return out.join(" ");
}

export function last4(number: string): string {
  const n = digitsOf(number);
  return n.length >= 4 ? n.slice(-4) : "";
}

// "MM/YY"。どちらかが無ければ有る方だけ、両方無ければ ""
export function formatExpiry(expMonth: string, expYear: string): string {
  const m = /^\d{1,2}$/.test(expMonth) ? expMonth.padStart(2, "0") : expMonth;
  const y = /^\d{4}$/.test(expYear) ? expYear.slice(2) : expYear;
  return [m, y].filter(Boolean).join("/");
}

// 編集画面の入力を保存する形にする（月は 0 埋めしない・年は 4 桁）
export function normalizeExpMonth(m: string): string {
  const t = m.trim();
  return /^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 12 ? String(Number(t)) : t;
}

export function normalizeExpYear(y: string): string {
  const t = y.trim();
  return /^\d{2}$/.test(t) ? `20${t}` : t;
}
