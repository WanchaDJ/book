export function upsertLogEntry(logs, entry, limit = 300) {
  const index = entry.logKey ? logs.findIndex((item) => item.logKey === entry.logKey) : -1;
  if (index >= 0) {
    logs[index] = entry;
    return { replaced: true, index };
  }

  logs.push(entry);
  while (logs.length > limit) logs.shift();
  return { replaced: false, index: logs.length - 1 };
}
