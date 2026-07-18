/**
 * AI scenario generation via the Claude API (structured outputs).
 *
 * The model sees the dataset schema — with the FIRST column emphasized, since
 * scenarios are anchored on the first field's values per the audit workflow —
 * plus sample rows, and returns executable rules in the DSL that engine.ts
 * evaluates deterministically.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Dataset, Rule, Scenario, Severity } from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const SAMPLE_ROWS = 8;

export function resolveModel(): string {
  return process.env.CORPCARD_MODEL ?? DEFAULT_MODEL;
}

export function assertApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to the MCP server's env config " +
        '(e.g. "env": {"ANTHROPIC_API_KEY": "sk-ant-..."}) and restart the client.',
    );
  }
}

interface GeneratedScenario {
  name: string;
  name_en: string;
  description: string;
  audit_rationale: string;
  severity: Severity;
  rule: Rule;
}

const CONDITION_VALUE_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    { type: "null" },
  ],
};

const CONDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["field", "operator", "value"],
  properties: {
    field: { type: "string" },
    operator: {
      type: "string",
      enum: [
        "eq", "neq", "gt", "gte", "lt", "lte",
        "contains", "not_contains", "starts_with", "ends_with",
        "in", "not_in", "regex", "is_empty", "not_empty",
        "is_weekend", "is_holiday_kr", "hour_between", "date_between",
        "top_percentile",
      ],
    },
    value: CONDITION_VALUE_SCHEMA,
  },
};

const RULE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "logic", "conditions"],
      properties: {
        type: { type: "string", enum: ["row"] },
        logic: { type: "string", enum: ["and", "or"] },
        conditions: { type: "array", items: CONDITION_SCHEMA },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "group_by", "period", "date_field", "filter", "having"],
      properties: {
        type: { type: "string", enum: ["aggregate"] },
        group_by: { type: "array", items: { type: "string" } },
        period: { type: "string", enum: ["none", "day", "month"] },
        date_field: { anyOf: [{ type: "string" }, { type: "null" }] },
        filter: { type: "array", items: CONDITION_SCHEMA },
        having: {
          type: "object",
          additionalProperties: false,
          required: ["metric", "field", "operator", "value"],
          properties: {
            metric: { type: "string", enum: ["count", "sum", "avg"] },
            field: { anyOf: [{ type: "string" }, { type: "null" }] },
            operator: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq"] },
            value: { type: "number" },
          },
        },
      },
    },
  ],
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenarios"],
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "name_en",
          "description",
          "audit_rationale",
          "severity",
          "rule",
        ],
        properties: {
          name: { type: "string" },
          name_en: { type: "string" },
          description: { type: "string" },
          audit_rationale: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          rule: RULE_SCHEMA,
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior internal auditor specializing in corporate card (법인카드) fraud and misuse detection. You design anomaly-detection scenarios that are executed by a deterministic rule engine over the full transaction dataset.

## Rule DSL semantics
Row rules ({"type":"row"}) flag individual transactions where conditions match (logic "and"/"or").
Aggregate rules ({"type":"aggregate"}) group rows by columns (optionally bucketed by day/month via date_field) after applying a row-level "filter" (AND), then flag groups where having.metric(field) passes the comparison. Use metric "count" with field null, or "sum"/"avg" with a numeric field.

Operators on a condition (field = exact column header from the dataset):
- eq/neq/in/not_in: value comparison (numeric-aware, case-insensitive)
- gt/gte/lt/lte: numeric comparison (handles "1,234,567", "₩12,000", "12000원")
- contains/not_contains/starts_with/ends_with: substring match; contains accepts an array meaning "contains any of"
- regex: JavaScript regex against the raw cell
- is_empty/not_empty: value null
- is_weekend: date column falls on Sat/Sun (value null)
- is_holiday_kr: date column is a Korean public holiday (value null)
- hour_between: value [startHour, endHour], end-exclusive, wraps midnight (e.g. [22,6] = late night). Only meaningful on datetime columns that include a time.
- date_between: value ["YYYY-MM-DD","YYYY-MM-DD"] inclusive
- top_percentile: value 0-100; numeric cell >= that percentile of its own column (e.g. 95 = top 5% amounts)

## Requirements
- Use ONLY column names that exist in the provided headers, exactly as written.
- Anchor scenarios on the FIRST column's values wherever meaningful (segment by its values with eq/in/contains conditions or group_by), and cover classic audit red flags relevant to the data: late-night/weekend/holiday use, split payments (same merchant, same day, multiple charges), just-under-approval-limit amounts, unusually large amounts (top_percentile), restricted merchant categories (유흥/주점/골프/상품권 등), duplicate transactions, excessive frequency or monthly totals per cardholder/department.
- Calibrate thresholds to the actual data statistics provided (numeric_stats, top_values). Do not invent thresholds wildly outside the data's range.
- Only use hour_between if a column actually contains time-of-day information; only use is_weekend/is_holiday_kr on date columns.
- Write name/description/audit_rationale in the dominant language of the dataset (Korean headers → Korean text); name_en is always English.
- Each scenario must be distinct — no near-duplicates.
- severity: high = likely policy violation/fraud, medium = needs explanation, low = monitoring signal.

Return exactly the requested number of scenarios.`;

export async function generateScenarios(
  dataset: Dataset,
  count: number,
  focus?: string,
): Promise<Array<Omit<Scenario, "id" | "source" | "created_at">>> {
  assertApiKey();
  const client = new Anthropic();

  const firstField = dataset.profile[0];
  const datasetBrief = {
    file: dataset.file_path,
    total_rows: dataset.rows.length,
    headers: dataset.headers,
    first_field: {
      name: firstField.name,
      note: "Scenarios must be anchored on this column's values where meaningful.",
      inferred_type: firstField.inferred_type,
      distinct_count: firstField.distinct_count,
      top_values: firstField.top_values,
    },
    columns: dataset.profile,
    sample_rows: dataset.rows.slice(0, SAMPLE_ROWS),
  };

  const userPrompt = [
    `Dataset profile (JSON):`,
    JSON.stringify(datasetBrief, null, 2),
    ``,
    `Generate exactly ${count} anomaly-detection scenario(s) for this corporate card dataset.`,
    focus ? `Additional audit focus requested by the user: ${focus}` : ``,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: resolveModel(),
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to process this request.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Model output was truncated. Try requesting fewer scenarios at a time.",
    );
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) {
    throw new Error("The model returned no text content.");
  }
  const parsed = JSON.parse(text) as { scenarios: GeneratedScenario[] };
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error("The model returned no scenarios. Try again.");
  }
  return parsed.scenarios;
}
