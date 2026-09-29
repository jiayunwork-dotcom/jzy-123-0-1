/**
 * 金额工具：系统内部一律使用「整数分」，杜绝浮点误差。
 * HTTP/前端使用十进制字符串（如 "12.34"）表示元，进入领域层前转换为分。
 */

export type Cents = number;

export function parseMoneyToCents(input: string | number): Cents {
  const raw = typeof input === 'number' ? input.toString() : input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`非法金额格式: ${input}`);
  }
  const [whole, fraction = ''] = raw.split('.');
  const fractionPadded = (fraction + '00').slice(0, 2);
  return Number(whole) * 100 + Number(fractionPadded);
}

/** 分 -> 元的字符串形式，仅用于展示（响应里同时给出分，前端也可自行格式化）。 */
export function formatCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = (abs % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
