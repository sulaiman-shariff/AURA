export function formatMetric(
  value: number | string | null | undefined,
  precision = 2,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric.toFixed(precision);
  return String(value);
}

export function hz(value: number | null | undefined, precision = 2): string {
  const text = formatMetric(value, precision);
  return text === "—" ? text : `${text} Hz`;
}

export function db(value: number | null | undefined, precision = 2): string {
  const text = formatMetric(value, precision);
  return text === "—" ? text : `${text} dB`;
}
