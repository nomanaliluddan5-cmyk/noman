const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 1) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(remaining, speed) {
  if (remaining == null || !speed || speed < 1) return null;
  const seconds = Math.ceil(remaining / speed);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

export function hostOf(href) {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}
