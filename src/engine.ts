/**
 * Deterministic rule engine.
 *
 * AI generates scenarios as structured rules (see types.ts); this engine
 * evaluates them against the full dataset so results are reproducible and
 * auditable — the AI never "eyeballs" individual transactions.
 */
import { isKoreanHoliday } from "./holidays.js";
import { parseDate, parseNumber, percentile } from "./parser.js";
import type {
  AggregateRule,
  Anomaly,
  Condition,
  Dataset,
  RowRule,
  Scenario,
  ScenarioResult,
} from "./types.js";

const MAX_STORED_ANOMALIES = 2000;
const MAX_GROUP_ROW_INDICES = 50;

interface EvalContext {
  dataset: Dataset;
  warnings: Set<string>;
  /** Lazily computed per-column percentile thresholds: "field|p" -> threshold */
  percentileCache: Map<string, number>;
  /** Resolved header lookup cache: requested name -> actual header or null */
  fieldCache: Map<string, string | null>;
}

export function runScenario(scenario: Scenario, dataset: Dataset): ScenarioResult {
  const ctx: EvalContext = {
    dataset,
    warnings: new Set(),
    percentileCache: new Map(),
    fieldCache: new Map(),
  };

  const anomalies =
    scenario.rule.type === "row"
      ? evalRowRule(scenario.rule, ctx)
      : evalAggregateRule(scenario.rule, ctx);

  return {
    scenario_id: scenario.id,
    scenario_name: scenario.name,
    severity: scenario.severity,
    analyzed_rows: dataset.rows.length,
    anomaly_count: anomalies.length,
    anomalies: anomalies.slice(0, MAX_STORED_ANOMALIES),
    warnings: [...ctx.warnings],
    analyzed_at: new Date().toISOString(),
  };
}

function evalRowRule(rule: RowRule, ctx: EvalContext): Anomaly[] {
  const anomalies: Anomaly[] = [];
  ctx.dataset.rows.forEach((row, i) => {
    const matched: string[] = [];
    let ok = rule.logic === "and";
    for (const cond of rule.conditions) {
      const hit = evalCondition(cond, row, ctx);
      if (hit) matched.push(describeCondition(cond));
      ok = rule.logic === "and" ? ok && hit : ok || hit;
      if (rule.logic === "and" && !hit) break;
    }
    if (rule.conditions.length === 0) ok = false;
    if (ok) {
      anomalies.push({
        type: "row",
        row_index: i + 1,
        row,
        reason: matched.join(" & "),
      });
    }
  });
  return anomalies;
}

function evalAggregateRule(rule: AggregateRule, ctx: EvalContext): Anomaly[] {
  const groupByFields = rule.group_by
    .map((f) => resolveField(f, ctx))
    .filter((f): f is string => f !== null);
  if (groupByFields.length === 0) {
    ctx.warnings.add(
      `Aggregate rule skipped: none of the group_by columns exist (${rule.group_by.join(", ")})`,
    );
    return [];
  }

  const dateField =
    rule.period !== "none" && rule.date_field
      ? resolveField(rule.date_field, ctx)
      : null;
  if (rule.period !== "none" && !dateField) {
    ctx.warnings.add(
      `period="${rule.period}" requested but date column "${rule.date_field}" was not found — grouping without a time bucket.`,
    );
  }

  const havingField = rule.having.field
    ? resolveField(rule.having.field, ctx)
    : null;
  if (rule.having.metric !== "count" && !havingField) {
    ctx.warnings.add(
      `Aggregate rule skipped: having.${rule.having.metric} requires a numeric column, but "${rule.having.field}" was not found.`,
    );
    return [];
  }

  interface Group {
    key: Record<string, string>;
    count: number;
    sum: number;
    numericCount: number;
    rowIndices: number[];
  }
  const groups = new Map<string, Group>();

  ctx.dataset.rows.forEach((row, i) => {
    for (const cond of rule.filter) {
      if (!evalCondition(cond, row, ctx)) return;
    }
    const key: Record<string, string> = {};
    for (const f of groupByFields) key[f] = row[f] ?? "";
    if (dateField) {
      const parsed = parseDate(row[dateField] ?? "");
      const bucket =
        parsed === null
          ? "(unparsed date)"
          : rule.period === "month"
            ? parsed.iso.slice(0, 7)
            : parsed.iso;
      key[`${rule.period}(${dateField})`] = bucket;
    }
    const mapKey = JSON.stringify(key);
    let g = groups.get(mapKey);
    if (!g) {
      g = { key, count: 0, sum: 0, numericCount: 0, rowIndices: [] };
      groups.set(mapKey, g);
    }
    g.count += 1;
    if (g.rowIndices.length < MAX_GROUP_ROW_INDICES) g.rowIndices.push(i + 1);
    if (havingField) {
      const n = parseNumber(row[havingField] ?? "");
      if (n !== null) {
        g.sum += n;
        g.numericCount += 1;
      }
    }
  });

  const anomalies: Anomaly[] = [];
  for (const g of groups.values()) {
    let metricValue: number;
    switch (rule.having.metric) {
      case "count":
        metricValue = g.count;
        break;
      case "sum":
        metricValue = g.sum;
        break;
      case "avg":
        metricValue = g.numericCount > 0 ? g.sum / g.numericCount : NaN;
        break;
    }
    if (Number.isNaN(metricValue)) continue;
    if (compare(metricValue, rule.having.operator, rule.having.value)) {
      anomalies.push({
        type: "group",
        group_key: g.key,
        metric_value: Math.round(metricValue * 100) / 100,
        row_indices: g.rowIndices,
        reason: `${rule.having.metric}(${rule.having.field ?? "*"}) = ${Math.round(metricValue * 100) / 100} ${rule.having.operator} ${rule.having.value}`,
      });
    }
  }
  anomalies.sort((a, b) => (b.metric_value ?? 0) - (a.metric_value ?? 0));
  return anomalies;
}

function compare(
  left: number,
  op: "gt" | "gte" | "lt" | "lte" | "eq",
  right: number,
): boolean {
  switch (op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
  }
}

function evalCondition(
  cond: Condition,
  row: Record<string, string>,
  ctx: EvalContext,
): boolean {
  const field = resolveField(cond.field, ctx);
  if (field === null) return false;
  const raw = row[field] ?? "";

  switch (cond.operator) {
    case "is_empty":
      return raw.trim() === "";
    case "not_empty":
      return raw.trim() !== "";
    case "eq":
      return looseEquals(raw, cond.value);
    case "neq":
      return raw.trim() !== "" && !looseEquals(raw, cond.value);
    case "contains":
      return containsAny(raw, cond.value);
    case "not_contains":
      return raw.trim() !== "" && !containsAny(raw, cond.value);
    case "starts_with":
      return raw.toLowerCase().startsWith(String(cond.value ?? "").toLowerCase());
    case "ends_with":
      return raw.toLowerCase().endsWith(String(cond.value ?? "").toLowerCase());
    case "in":
      return asArray(cond.value).some((v) => looseEquals(raw, v));
    case "not_in":
      return (
        raw.trim() !== "" && !asArray(cond.value).some((v) => looseEquals(raw, v))
      );
    case "regex": {
      try {
        return new RegExp(String(cond.value ?? "")).test(raw);
      } catch {
        ctx.warnings.add(`Invalid regex ignored: ${String(cond.value)}`);
        return false;
      }
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = parseNumber(raw);
      const target =
        typeof cond.value === "number" ? cond.value : parseNumber(String(cond.value ?? ""));
      if (n === null || target === null) return false;
      return compare(n, cond.operator, target);
    }
    case "is_weekend": {
      const p = parseDate(raw);
      return p !== null && (p.dayOfWeek === 0 || p.dayOfWeek === 6);
    }
    case "is_holiday_kr": {
      const p = parseDate(raw);
      return p !== null && isKoreanHoliday(p.iso);
    }
    case "hour_between": {
      const p = parseDate(raw);
      if (p === null || p.hour === null) return false;
      const [start, end] = asArray(cond.value).map(Number);
      if (Number.isNaN(start) || Number.isNaN(end)) return false;
      // End-exclusive; wraps midnight, e.g. [22, 6] = 22:00–05:59.
      return start <= end
        ? p.hour >= start && p.hour < end
        : p.hour >= start || p.hour < end;
    }
    case "date_between": {
      const p = parseDate(raw);
      if (p === null) return false;
      const [from, to] = asArray(cond.value).map(String);
      return p.iso >= from && p.iso <= to;
    }
    case "top_percentile": {
      const n = parseNumber(raw);
      if (n === null) return false;
      const pct = typeof cond.value === "number" ? cond.value : Number(cond.value);
      if (Number.isNaN(pct)) return false;
      const threshold = percentileThreshold(field, pct, ctx);
      return threshold !== null && n >= threshold;
    }
  }
}

function percentileThreshold(
  field: string,
  pct: number,
  ctx: EvalContext,
): number | null {
  const cacheKey = `${field}|${pct}`;
  const cached = ctx.percentileCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const values = ctx.dataset.rows
    .map((r) => parseNumber(r[field] ?? ""))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    ctx.warnings.add(`top_percentile: column "${field}" has no numeric values.`);
    return null;
  }
  const threshold = percentile(values, pct);
  ctx.percentileCache.set(cacheKey, threshold);
  return threshold;
}

/** Numeric-aware, case-insensitive equality ("12,000" == 12000, "Yes" == "yes"). */
function looseEquals(raw: string, value: Condition["value"]): boolean {
  if (value === null) return false;
  const nRaw = parseNumber(raw);
  const nVal =
    typeof value === "number" ? value : parseNumber(String(value));
  if (nRaw !== null && nVal !== null) return nRaw === nVal;
  return raw.trim().toLowerCase() === String(value).trim().toLowerCase();
}

function containsAny(raw: string, value: Condition["value"]): boolean {
  const haystack = raw.toLowerCase();
  return asArray(value).some((v) =>
    haystack.includes(String(v).toLowerCase()),
  );
}

function asArray(value: Condition["value"]): Array<string | number> {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Resolves a rule's column name against actual headers (exact → case/space-insensitive). */
function resolveField(name: string, ctx: EvalContext): string | null {
  const cached = ctx.fieldCache.get(name);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  if (ctx.dataset.headers.includes(name)) {
    resolved = name;
  } else {
    const normalized = normalizeHeader(name);
    resolved =
      ctx.dataset.headers.find((h) => normalizeHeader(h) === normalized) ?? null;
  }
  if (resolved === null) {
    ctx.warnings.add(
      `Column "${name}" not found in dataset headers — conditions on it never match.`,
    );
  }
  ctx.fieldCache.set(name, resolved);
  return resolved;
}

function normalizeHeader(h: string): string {
  return h.replace(/\s+/g, "").toLowerCase();
}

function describeCondition(cond: Condition): string {
  const v =
    cond.value === null
      ? ""
      : Array.isArray(cond.value)
        ? ` [${cond.value.join(", ")}]`
        : ` ${cond.value}`;
  return `${cond.field} ${cond.operator}${v}`;
}
