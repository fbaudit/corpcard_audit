/**
 * Data loading (CSV / XLSX) and column profiling.
 *
 * Korean card statements are frequently exported as EUC-KR / CP949 CSVs, so
 * CSV bytes are decoded as UTF-8 first and re-decoded as CP949 when the UTF-8
 * decode produces replacement characters.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import type { ColumnProfile, Dataset } from "./types.js";

const PROFILE_SAMPLE_LIMIT = 5000;
const TOP_VALUES_LIMIT = 12;

export function loadDataset(
  filePath: string,
  sheetName?: string,
  skipRows?: number,
): Dataset {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `File not found: ${resolved}. Provide an absolute path to a .csv, .xlsx, or .xls file.`,
    );
  }
  const buf = fs.readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();

  let workbook: XLSX.WorkBook;
  if (ext === ".csv" || ext === ".txt" || ext === ".tsv") {
    workbook = XLSX.read(decodeText(buf), { type: "string", raw: true });
  } else {
    workbook = XLSX.read(buf, { type: "buffer" });
  }

  const chosenSheet = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[chosenSheet];
  if (!sheet) {
    throw new Error(
      `Sheet "${chosenSheet}" not found. Available sheets: ${workbook.SheetNames.join(", ")}`,
    );
  }

  const matrix: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
  const afterSkip = skipRows && skipRows > 0 ? matrix.slice(skipRows) : matrix;
  const nonEmptyRows = afterSkip.filter((r) =>
    r.some((c) => String(c ?? "").trim() !== ""),
  );
  if (nonEmptyRows.length < 2) {
    throw new Error(
      "The file must contain a header row and at least one data row." +
        (skipRows ? ` (skip_rows=${skipRows} left too few rows)` : ""),
    );
  }

  // With an explicit skip_rows, the caller says "the next row IS the header".
  // Otherwise, auto-detect: bank/card-company exports often carry title and
  // summary lines above the real header row.
  const headerIdx = skipRows && skipRows > 0 ? 0 : detectHeaderIndex(nonEmptyRows);

  const headers = nonEmptyRows[headerIdx].map((h, i) => {
    const name = String(h ?? "").trim();
    return name === "" ? `column_${i + 1}` : name;
  });

  const rows: Array<Record<string, string>> = nonEmptyRows
    .slice(headerIdx + 1)
    .map((r) => {
      const record: Record<string, string> = {};
      headers.forEach((h, i) => {
        record[h] = String(r[i] ?? "").trim();
      });
      return record;
    });

  if (rows.length === 0) {
    throw new Error("No data rows found below the header row.");
  }

  return {
    file_path: resolved,
    sheet_name: chosenSheet,
    headers,
    rows,
    profile: profileColumns(headers, rows),
    skipped_leading_rows: (skipRows ?? 0) + headerIdx,
    loaded_at: new Date().toISOString(),
  };
}

const HEADER_SCAN_LIMIT = 20;

/**
 * Finds the most likely header row among the leading rows.
 * Heuristic: the first sufficiently-wide row whose cells are mostly
 * non-numeric/non-date and mutually distinct. Title lines ("법인카드
 * 사용내역") and summary lines ("조회기간: ...") have too few cells and are
 * skipped; data rows are rejected by the numeric/date share check.
 */
function detectHeaderIndex(nonEmptyRows: unknown[][]): number {
  const scan = nonEmptyRows.slice(0, HEADER_SCAN_LIMIT);
  const widths = scan.map(
    (r) => r.filter((c) => String(c ?? "").trim() !== "").length,
  );
  const maxWidth = Math.max(...widths);
  const minHeaderWidth = Math.max(2, Math.ceil(maxWidth * 0.7));

  for (let i = 0; i < scan.length - 1; i++) {
    const cells = scan[i]
      .map((c) => String(c ?? "").trim())
      .filter((v) => v !== "");
    if (cells.length < minHeaderWidth) continue;
    const dataLike = cells.filter(
      (v) => parseNumber(v) !== null || parseDate(v) !== null,
    ).length;
    if (dataLike / cells.length >= 0.5) continue;
    const distinct =
      new Set(cells.map((c) => c.toLowerCase())).size === cells.length;
    if (!distinct) continue;
    return i;
  }
  return 0;
}

function decodeText(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  // U+FFFD indicates bytes that were not valid UTF-8 → assume CP949 (EUC-KR).
  if (utf8.includes("�")) {
    return iconv.decode(buf, "cp949");
  }
  return utf8.replace(/^﻿/, "");
}

export function profileColumns(
  headers: string[],
  rows: Array<Record<string, string>>,
): ColumnProfile[] {
  const sample = rows.slice(0, PROFILE_SAMPLE_LIMIT);
  return headers.map((name, index) => {
    const values = sample.map((r) => r[name] ?? "").filter((v) => v !== "");
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

    const numericValues = values
      .map(parseNumber)
      .filter((n): n is number => n !== null);
    const dateHits = values.filter((v) => parseDate(v) !== null);
    const timeHits = values.filter((v) => hasTimeComponent(v));

    let inferredType: ColumnProfile["inferred_type"] = "text";
    if (values.length > 0) {
      if (dateHits.length >= values.length * 0.8) {
        inferredType =
          timeHits.length >= values.length * 0.5 ? "datetime" : "date";
      } else if (numericValues.length >= values.length * 0.8) {
        inferredType = "number";
      }
    }

    const profile: ColumnProfile = {
      name,
      index,
      inferred_type: inferredType,
      non_empty: values.length,
      distinct_count: counts.size,
      top_values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_VALUES_LIMIT)
        .map(([value, count]) => ({ value, count })),
    };

    if (inferredType === "number" && numericValues.length > 0) {
      const sorted = [...numericValues].sort((a, b) => a - b);
      profile.numeric_stats = {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean:
          Math.round(
            (sorted.reduce((s, n) => s + n, 0) / sorted.length) * 100,
          ) / 100,
        p95: percentile(sorted, 95),
      };
    }
    return profile;
  });
}

/** Parses "1,234,567", "₩12,000", "12000원", "-3,000" etc. */
export function parseNumber(raw: string): number | null {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(/[,\s]/g, "")
    .replace(/[₩$€¥]|KRW|USD|원/gi, "");
  if (cleaned === "" || cleaned === "-") return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

interface ParsedDate {
  iso: string; // YYYY-MM-DD
  hour: number | null;
  minute: number | null;
  dayOfWeek: number; // 0 = Sunday
}

const DATE_RE =
  /(\d{4})[.\-/년\s]{1,2}(\d{1,2})[.\-/월\s]{1,2}(\d{1,2})일?/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::\d{2})?/;
const COMPACT_TIME_RE = /^(?:\d{8})(\d{2})(\d{2})(?:\d{2})?$/;

/** Parses common Korean/ISO date formats; returns null if not a date. */
export function parseDate(raw: string): ParsedDate | null {
  if (!raw) return null;
  const s = String(raw).trim();

  let y: number | null = null;
  let mo: number | null = null;
  let d: number | null = null;

  const m = DATE_RE.exec(s);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    // Compact forms like "20240115" or "20240115 2330" / "202401152330"
    const digits = s.replace(/\D/g, "");
    if (/^\d{8}(\d{4,6})?$/.test(digits)) {
      const c = COMPACT_DATE_RE.exec(digits);
      if (c) {
        y = Number(c[1]);
        mo = Number(c[2]);
        d = Number(c[3]);
      }
    }
  }

  if (y === null || mo === null || d === null) return null;
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  let hour: number | null = null;
  let minute: number | null = null;
  const t = TIME_RE.exec(s);
  if (t) {
    hour = Number(t[1]);
    minute = Number(t[2]);
  } else {
    const digits = s.replace(/\D/g, "");
    const ct = COMPACT_TIME_RE.exec(digits);
    if (ct) {
      hour = Number(ct[1]);
      minute = Number(ct[2]);
    }
  }
  if (hour !== null && (hour > 23 || (minute !== null && minute > 59))) {
    hour = null;
    minute = null;
  }

  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dayOfWeek = new Date(`${iso}T00:00:00`).getDay();
  return { iso, hour, minute, dayOfWeek };
}

function hasTimeComponent(raw: string): boolean {
  const p = parseDate(raw);
  return p !== null && p.hour !== null;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}
