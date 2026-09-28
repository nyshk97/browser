// パスワード生成。棄却サンプリングで偏りを出さない
export const CHARSETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.<>/?~",
} as const;

export type CharsetName = keyof typeof CHARSETS;

export interface GeneratorOptions {
  length: number;
  sets: CharsetName[];
}

export const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, sets: ["lower", "upper", "digits", "symbols"] };

export function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

// 選んだ文字種がすべて1文字以上入るまで作り直す（条件付きでも一様になる）
export function generatePassword(opts: GeneratorOptions): string {
  const sets = opts.sets.length > 0 ? opts.sets : (["lower"] as CharsetName[]);
  const length = Math.max(4, Math.min(128, Math.floor(opts.length)));
  const pool = sets.map((s) => CHARSETS[s]).join("");
  for (;;) {
    let pw = "";
    for (let i = 0; i < length; i++) pw += pool[randomIndex(pool.length)];
    if (length < sets.length || sets.every((s) => [...CHARSETS[s]].some((c) => pw.includes(c)))) return pw;
  }
}

// 強度の目安（ビット）。文字種の数と長さからの素朴な見積もり
export function estimateBits(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  return pool === 0 ? 0 : Math.round([...pw].length * Math.log2(pool));
}
