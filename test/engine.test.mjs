/**
 * Engine + parser regression tests against the bundled sample data.
 * Run with: npm run build && npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDataset, parseNumber, parseDate } from "../dist/parser.js";
import { runScenario } from "../dist/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(here, "..", "sample_data", "sample_card_data.csv");

const scenario = (rule, overrides = {}) => ({
  id: "T1",
  name: "test",
  name_en: "test",
  description: "",
  audit_rationale: "",
  severity: "high",
  source: "manual",
  created_at: new Date().toISOString(),
  rule,
  ...overrides,
});

test("loads sample CSV with Korean headers", () => {
  const ds = loadDataset(samplePath);
  assert.equal(ds.rows.length, 40);
  assert.equal(ds.headers[0], "카드번호");
  assert.equal(ds.profile[0].distinct_count, 5);
  assert.equal(ds.profile.find((p) => p.name === "사용금액").inferred_type, "number");
  assert.equal(ds.profile.find((p) => p.name === "사용일시").inferred_type, "datetime");
});

test("auto-detects header below title/summary preamble rows", () => {
  const ds = loadDataset(path.join(here, "fixtures", "raw_export_with_preamble.csv"));
  assert.equal(ds.headers.join("|"), "카드번호|사용일시|가맹점명|사용금액");
  assert.equal(ds.rows.length, 3);
  assert.ok(ds.skipped_leading_rows >= 3);
});

test("explicit skip_rows overrides auto-detection", () => {
  const ds = loadDataset(
    path.join(here, "fixtures", "raw_export_with_preamble.csv"),
    undefined,
    4,
  );
  assert.equal(ds.headers[0], "카드번호");
  assert.equal(ds.rows.length, 3);
});

test("clean files (header on row 1) are unaffected by detection", () => {
  const ds = loadDataset(samplePath);
  assert.equal(ds.skipped_leading_rows, 0);
  assert.equal(ds.rows.length, 40);
});

test("parseNumber handles Korean currency formats", () => {
  assert.equal(parseNumber("1,234,567"), 1234567);
  assert.equal(parseNumber("₩12,000"), 12000);
  assert.equal(parseNumber("12000원"), 12000);
  assert.equal(parseNumber("-3,000"), -3000);
  assert.equal(parseNumber("가맹점"), null);
});

test("parseDate handles common Korean/ISO formats", () => {
  assert.equal(parseDate("2025-03-08 00:15").iso, "2025-03-08");
  assert.equal(parseDate("2025-03-08 00:15").hour, 0);
  assert.equal(parseDate("2025.03.08").iso, "2025-03-08");
  assert.equal(parseDate("2025년 3월 8일").iso, "2025-03-08");
  assert.equal(parseDate("20250308").iso, "2025-03-08");
  assert.equal(parseDate("hello"), null);
});

test("hour_between wraps midnight (late-night rule)", () => {
  const ds = loadDataset(samplePath);
  const r = runScenario(
    scenario({
      type: "row",
      logic: "and",
      conditions: [{ field: "사용일시", operator: "hour_between", value: [22, 6] }],
    }),
    ds,
  );
  assert.equal(r.anomaly_count, 6);
});

test("aggregate rule detects split payments per day", () => {
  const ds = loadDataset(samplePath);
  const r = runScenario(
    scenario({
      type: "aggregate",
      group_by: ["카드번호", "가맹점명"],
      period: "day",
      date_field: "사용일시",
      filter: [],
      having: { metric: "count", field: null, operator: "gte", value: 2 },
    }),
    ds,
  );
  assert.equal(r.anomaly_count, 2);
  assert.equal(r.anomalies[0].group_key["가맹점명"], "장수갈비");
});

test("unknown column produces a warning, not a crash", () => {
  const ds = loadDataset(samplePath);
  const r = runScenario(
    scenario({
      type: "row",
      logic: "and",
      conditions: [{ field: "없는컬럼", operator: "eq", value: "x" }],
    }),
    ds,
  );
  assert.equal(r.anomaly_count, 0);
  assert.equal(r.warnings.length, 1);
});

test("top_percentile flags high amounts", () => {
  const ds = loadDataset(samplePath);
  const r = runScenario(
    scenario({
      type: "row",
      logic: "and",
      conditions: [{ field: "사용금액", operator: "top_percentile", value: 90 }],
    }),
    ds,
  );
  assert.ok(r.anomaly_count >= 4 && r.anomaly_count <= 6);
});
