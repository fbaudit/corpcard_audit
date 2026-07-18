/**
 * Core type definitions for the corporate card audit MCP server.
 */

export type Severity = "high" | "medium" | "low";

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "regex"
  | "is_empty"
  | "not_empty"
  | "is_weekend"
  | "is_holiday_kr"
  | "hour_between"
  | "date_between"
  | "top_percentile";

export interface Condition {
  /** Column name exactly as it appears in the dataset header (Korean or English). */
  field: string;
  operator: ConditionOperator;
  /**
   * Comparison value. Shape depends on operator:
   * - eq/neq/contains/...: string | number
   * - in/not_in: array
   * - hour_between: [startHour, endHour] (end exclusive, wraps midnight)
   * - date_between: ["YYYY-MM-DD", "YYYY-MM-DD"]
   * - top_percentile: number 0-100 (e.g. 95 = top 5% of that numeric column)
   * - is_weekend/is_holiday_kr/is_empty/not_empty: null
   */
  value: string | number | Array<string | number> | null;
}

export interface RowRule {
  type: "row";
  logic: "and" | "or";
  conditions: Condition[];
}

export interface AggregateHaving {
  metric: "count" | "sum" | "avg";
  /** Numeric column for sum/avg. null for count. */
  field: string | null;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  value: number;
}

export interface AggregateRule {
  type: "aggregate";
  /** Columns to group rows by (e.g. merchant + user). */
  group_by: string[];
  /** Optional time bucketing applied on top of group_by. */
  period: "none" | "day" | "month";
  /** Date/datetime column used when period != "none". */
  date_field: string | null;
  /** Row-level pre-filter (AND) applied before grouping. May be empty. */
  filter: Condition[];
  having: AggregateHaving;
}

export type Rule = RowRule | AggregateRule;

export interface Scenario {
  id: string;
  name: string;
  name_en: string;
  description: string;
  audit_rationale: string;
  severity: Severity;
  rule: Rule;
  source: "ai" | "manual";
  created_at: string;
}

export interface Anomaly {
  type: "row" | "group";
  /** 1-based data row number (header excluded). Present for row anomalies. */
  row_index?: number;
  row?: Record<string, string>;
  /** Present for group anomalies. */
  group_key?: Record<string, string>;
  metric_value?: number;
  row_indices?: number[];
  reason: string;
}

export interface ScenarioResult {
  scenario_id: string;
  scenario_name: string;
  severity: Severity;
  analyzed_rows: number;
  anomaly_count: number;
  anomalies: Anomaly[];
  warnings: string[];
  analyzed_at: string;
}

export interface ColumnProfile {
  name: string;
  index: number;
  inferred_type: "number" | "date" | "datetime" | "text";
  non_empty: number;
  distinct_count: number;
  top_values: Array<{ value: string; count: number }>;
  numeric_stats?: { min: number; max: number; mean: number; p95: number };
}

export interface Dataset {
  file_path: string;
  sheet_name?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  profile: ColumnProfile[];
  loaded_at: string;
}
