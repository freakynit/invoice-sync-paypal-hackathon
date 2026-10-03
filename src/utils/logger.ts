export function logInfo(message: string, fields?: Record<string, unknown>): void {
  const base = { level: 'info', time: new Date().toISOString(), message, ...(fields ?? {}) };
  console.log(JSON.stringify(base));
}

export function logWarn(message: string, fields?: Record<string, unknown>): void {
  const base = { level: 'warn', time: new Date().toISOString(), message, ...(fields ?? {}) };
  console.warn(JSON.stringify(base));
}

export function logError(message: string, fields?: Record<string, unknown>): void {
  const base = { level: 'error', time: new Date().toISOString(), message, ...(fields ?? {}) };
  console.error(JSON.stringify(base));
}
