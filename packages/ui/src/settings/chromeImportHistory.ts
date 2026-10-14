// Chrome import history — machine-level record of the last completed import so
// the settings page can tell the user the data is already in (and when), instead
// of offering a stateless "import everything" button every visit.
const STORAGE_KEY = "zcode.chromeImport.lastResult.v1";

export interface ChromeImportRecord {
  at: number;
  cookies: number;
  passwords: number;
  origins: number;
  entries: number;
}

interface StorageShape {
  at: number;
  cookies: number;
  passwords: number;
  origins: number;
  entries: number;
}

function parseRecord(raw: string | null): ChromeImportRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StorageShape>;
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return {
      at: parsed.at,
      cookies: Math.max(0, Math.trunc(parsed.cookies ?? 0)),
      passwords: Math.max(0, Math.trunc(parsed.passwords ?? 0)),
      origins: Math.max(0, Math.trunc(parsed.origins ?? 0)),
      entries: Math.max(0, Math.trunc(parsed.entries ?? 0)),
    };
  } catch {
    return null;
  }
}

export function readChromeImportRecord(): ChromeImportRecord | null {
  try {
    return parseRecord(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeChromeImportRecord(result: {
  cookies: { imported: number };
  passwords: { imported: number };
  localStorage: { originsImported: number; entriesImported: number };
}): ChromeImportRecord {
  const record: ChromeImportRecord = {
    at: Date.now(),
    cookies: result.cookies.imported,
    passwords: result.passwords.imported,
    origins: result.localStorage.originsImported,
    entries: result.localStorage.entriesImported,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 存储不可用时静默降级：本次会话内仍然显示（调用方持有返回值）。
  }
  return record;
}
