#!/usr/bin/env node
/**
 * corpcard-audit-mcp-server
 *
 * MCP server for AI-powered corporate card (법인카드) anomaly detection.
 * Workflow: load data → generate scenarios with Claude (anchored on the first
 * column) → the deterministic rule engine runs them automatically → export an
 * audit report.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateScenarios, resolveModel } from "./ai.js";
import { runScenario } from "./engine.js";
import { loadDataset } from "./parser.js";
import { buildCsvExport, buildMarkdownReport } from "./report.js";
import { nextScenarioId, requireDataset, state } from "./state.js";
import type { Scenario, ScenarioResult } from "./types.js";

const CHARACTER_LIMIT = 25000;
const PREVIEW_ANOMALIES = 5;

const server = new McpServer({
  name: "corpcard-audit-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' (human-readable) or 'json'");

const conditionSchema = z.object({
  field: z.string(),
  operator: z.enum([
    "eq", "neq", "gt", "gte", "lt", "lte",
    "contains", "not_contains", "starts_with", "ends_with",
    "in", "not_in", "regex", "is_empty", "not_empty",
    "is_weekend", "is_holiday_kr", "hour_between", "date_between",
    "top_percentile",
  ]),
  value: z
    .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()])
    .default(null),
});

const ruleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("row"),
    logic: z.enum(["and", "or"]).default("and"),
    conditions: z.array(conditionSchema).min(1),
  }),
  z.object({
    type: z.literal("aggregate"),
    group_by: z.array(z.string()).min(1),
    period: z.enum(["none", "day", "month"]).default("none"),
    date_field: z.string().nullable().default(null),
    filter: z.array(conditionSchema).default([]),
    having: z.object({
      metric: z.enum(["count", "sum", "avg"]),
      field: z.string().nullable().default(null),
      operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
      value: z.number(),
    }),
  }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

function runScenarios(scenarios: Scenario[]): ScenarioResult[] {
  const dataset = requireDataset();
  return scenarios.map((s) => {
    const result = runScenario(s, dataset);
    state.results.set(s.id, result);
    return result;
  });
}

function severityBadge(sev: string): string {
  return sev === "high" ? "🔴 high" : sev === "medium" ? "🟠 medium" : "🟡 low";
}

function summarizeResults(results: ScenarioResult[]): string[] {
  const lines: string[] = [];
  lines.push(`| ID | 시나리오 | 심각도 | 탐지 건수 |`);
  lines.push(`|----|----------|--------|-----------|`);
  for (const r of results) {
    lines.push(
      `| ${r.scenario_id} | ${r.scenario_name} | ${severityBadge(r.severity)} | ${r.anomaly_count} |`,
    );
  }
  const warnings = results.flatMap((r) => r.warnings.map((w) => `⚠️ [${r.scenario_id}] ${w}`));
  if (warnings.length > 0) {
    lines.push("", ...warnings);
  }
  return lines;
}

function previewAnomalies(r: ScenarioResult): string[] {
  const lines: string[] = [];
  for (const a of r.anomalies.slice(0, PREVIEW_ANOMALIES)) {
    if (a.type === "row") {
      const rowText = Object.entries(a.row ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`  - 행 ${a.row_index}: ${rowText}`);
    } else {
      const keyText = Object.entries(a.group_key ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`  - 그룹 [${keyText}] → ${a.reason}`);
    }
  }
  if (r.anomaly_count > PREVIEW_ANOMALIES) {
    lines.push(
      `  - … 외 ${r.anomaly_count - PREVIEW_ANOMALIES}건 (corpcard_get_anomalies로 전체 조회)`,
    );
  }
  return lines;
}

function truncate(text: string, note: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return text.slice(0, CHARACTER_LIMIT) + `\n\n…(truncated) ${note}`;
}

// ---------------------------------------------------------------------------
// Tool: corpcard_load_data
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_load_data",
  {
    title: "Load Corporate Card Data",
    description: `Load a corporate card transaction file (CSV / XLSX / XLS) into the audit session and profile its columns.

Korean CSV encodings (EUC-KR/CP949) are detected automatically. The first row must be the header row; headers may be Korean or English. If detection scenarios already exist in the session, they are automatically re-run against the newly loaded data and the anomaly summary is included in the response.

Args:
  - file_path (string): Absolute path to the .csv/.xlsx/.xls file
  - sheet (string, optional): Sheet name for Excel files (default: first sheet)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: dataset profile — row count, per-column inferred types and top values, with the FIRST column highlighted (scenario generation is anchored on it) — plus auto-analysis results when scenarios exist.`,
    inputSchema: {
      file_path: z.string().describe("Absolute path to the CSV/XLSX/XLS file"),
      sheet: z.string().optional().describe("Excel sheet name (default: first sheet)"),
      response_format: responseFormatSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ file_path, sheet, response_format }) => {
    try {
      const dataset = loadDataset(file_path, sheet);
      state.dataset = dataset;
      state.results.clear();

      const autoResults =
        state.scenarios.length > 0 ? runScenarios(state.scenarios) : [];

      if (response_format === "json") {
        return ok(
          JSON.stringify(
            {
              file_path: dataset.file_path,
              sheet: dataset.sheet_name,
              total_rows: dataset.rows.length,
              headers: dataset.headers,
              first_field: dataset.profile[0],
              columns: dataset.profile,
              auto_analysis: autoResults.map((r) => ({
                scenario_id: r.scenario_id,
                scenario_name: r.scenario_name,
                anomaly_count: r.anomaly_count,
              })),
            },
            null,
            2,
          ),
        );
      }

      const first = dataset.profile[0];
      const lines: string[] = [];
      lines.push(`# 데이터 로드 완료`);
      lines.push(``);
      lines.push(`- **파일**: ${dataset.file_path}`);
      if (dataset.sheet_name) lines.push(`- **시트**: ${dataset.sheet_name}`);
      lines.push(`- **거래 건수**: ${dataset.rows.length.toLocaleString()}`);
      lines.push(`- **컬럼 수**: ${dataset.headers.length}`);
      lines.push(``);
      lines.push(
        `## 첫 번째 필드: \`${first.name}\` (시나리오 생성 기준 필드)`,
      );
      lines.push(
        `- 타입: ${first.inferred_type}, 고유값 ${first.distinct_count}개`,
      );
      lines.push(
        `- 상위 값: ${first.top_values.map((v) => `${v.value}(${v.count})`).join(", ")}`,
      );
      lines.push(``);
      lines.push(`## 전체 컬럼`);
      lines.push(`| # | 컬럼 | 타입 | 비어있지 않은 값 | 고유값 |`);
      lines.push(`|---|------|------|------------------|--------|`);
      for (const c of dataset.profile) {
        lines.push(
          `| ${c.index + 1} | ${c.name} | ${c.inferred_type} | ${c.non_empty} | ${c.distinct_count} |`,
        );
      }
      if (autoResults.length > 0) {
        lines.push(``, `## 기존 시나리오 자동 분석 결과`, ``);
        lines.push(...summarizeResults(autoResults));
      } else {
        lines.push(
          ``,
          `다음 단계: \`corpcard_generate_scenarios\`로 이상징후 탐지 시나리오를 생성하세요 (생성 즉시 자동 분석됩니다).`,
        );
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_generate_scenarios
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_generate_scenarios",
  {
    title: "Generate Anomaly Detection Scenarios (AI)",
    description: `Generate the requested number of anomaly-detection scenarios using the Claude API, anchored on the FIRST column of the loaded dataset, then automatically run them against the loaded data and return the anomaly summary.

Requires card data to be loaded first (corpcard_load_data) and the ANTHROPIC_API_KEY environment variable to be set on the server.

Args:
  - count (number): How many scenarios to generate (1-20)
  - focus (string, optional): Extra audit focus, e.g. "심야/주말 사용과 분할결제 위주로"
  - replace (boolean): true = discard existing scenarios first; false = append (default false)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the generated scenarios (name, severity, rule) and, since data is loaded, the automatic analysis result per scenario (anomaly counts + sample detections).

Error Handling:
  - "No card data loaded" → call corpcard_load_data first
  - "ANTHROPIC_API_KEY is not set" → add the key to the MCP server env config`,
    inputSchema: {
      count: z.number().int().min(1).max(20).describe("Number of scenarios to generate (1-20)"),
      focus: z.string().optional().describe("Optional audit focus/instructions for the AI"),
      replace: z
        .boolean()
        .default(false)
        .describe("Discard existing scenarios before adding new ones"),
      response_format: responseFormatSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ count, focus, replace, response_format }) => {
    try {
      const dataset = requireDataset();
      const generated = await generateScenarios(dataset, count, focus);

      if (replace) {
        state.scenarios = [];
        state.results.clear();
      }
      const now = new Date().toISOString();
      const created: Scenario[] = generated.map((g) => ({
        ...g,
        id: nextScenarioId(),
        source: "ai",
        created_at: now,
      }));
      state.scenarios.push(...created);

      // Requirement: scenarios auto-run whenever data is present.
      const results = runScenarios(created);

      if (response_format === "json") {
        return ok(
          JSON.stringify(
            {
              model: resolveModel(),
              generated: created,
              analysis: results,
            },
            null,
            2,
          ),
        );
      }

      const lines: string[] = [];
      lines.push(`# 시나리오 ${created.length}개 생성 및 자동 분석 완료`);
      lines.push(``);
      for (const s of created) {
        const r = state.results.get(s.id)!;
        lines.push(`## ${s.id}. ${s.name} — ${severityBadge(s.severity)}`);
        lines.push(`- ${s.description}`);
        lines.push(`- 감사 근거: ${s.audit_rationale}`);
        lines.push(`- **탐지 건수: ${r.anomaly_count}**`);
        for (const w of r.warnings) lines.push(`- ⚠️ ${w}`);
        lines.push(...previewAnomalies(r));
        lines.push(``);
      }
      lines.push(`## 요약`);
      lines.push(...summarizeResults(results));
      lines.push(
        ``,
        `전체 탐지 내역: \`corpcard_get_anomalies\`, 보고서 저장: \`corpcard_export_report\``,
      );
      return ok(truncate(lines.join("\n"), "Use corpcard_get_anomalies for full details."));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_add_scenario
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_add_scenario",
  {
    title: "Add a Manual Scenario",
    description: `Add a hand-written detection scenario (rule DSL) without calling the AI, then run it automatically if data is loaded.

Rule DSL (JSON):
  Row rule:       {"type":"row","logic":"and|or","conditions":[{"field":"<header>","operator":"...","value":...}]}
  Aggregate rule: {"type":"aggregate","group_by":["<header>"],"period":"none|day|month","date_field":"<header>|null","filter":[...conditions],"having":{"metric":"count|sum|avg","field":"<header>|null","operator":"gt|gte|lt|lte|eq","value":123}}
  Operators: eq, neq, gt, gte, lt, lte, contains, not_contains, starts_with, ends_with, in, not_in, regex, is_empty, not_empty, is_weekend, is_holiday_kr, hour_between ([start,end], end-exclusive, wraps midnight), date_between (["YYYY-MM-DD","YYYY-MM-DD"]), top_percentile (0-100).

Args:
  - name (string): Scenario name (dataset language)
  - name_en (string): English name
  - description (string): What the scenario detects
  - audit_rationale (string): Why it matters from an audit perspective
  - severity ('high'|'medium'|'low')
  - rule (object): Rule DSL object as described above

Returns: the stored scenario with its assigned ID and, if data is loaded, its anomaly count.`,
    inputSchema: {
      name: z.string().min(1),
      name_en: z.string().min(1),
      description: z.string().min(1),
      audit_rationale: z.string().min(1),
      severity: z.enum(["high", "medium", "low"]),
      rule: ruleSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ name, name_en, description, audit_rationale, severity, rule }) => {
    try {
      const scenario: Scenario = {
        id: nextScenarioId(),
        name,
        name_en,
        description,
        audit_rationale,
        severity,
        rule,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      state.scenarios.push(scenario);

      const lines: string[] = [`시나리오 ${scenario.id} (${name}) 추가 완료.`];
      if (state.dataset) {
        const [r] = runScenarios([scenario]);
        lines.push(`자동 분석 결과: 탐지 ${r.anomaly_count}건`);
        for (const w of r.warnings) lines.push(`⚠️ ${w}`);
        lines.push(...previewAnomalies(r));
      } else {
        lines.push(
          `데이터가 아직 없어 분석은 보류되었습니다. corpcard_load_data 실행 시 자동 분석됩니다.`,
        );
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_list_scenarios
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_list_scenarios",
  {
    title: "List Detection Scenarios",
    description: `List all detection scenarios in the current session, including their rules and latest analysis result (if any).

Args:
  - response_format ('markdown' | 'json'): default 'markdown'. Use 'json' to see the full rule DSL of each scenario.`,
    inputSchema: {
      response_format: responseFormatSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ response_format }) => {
    try {
      if (state.scenarios.length === 0) {
        return ok(
          "등록된 시나리오가 없습니다. corpcard_generate_scenarios로 생성하거나 corpcard_add_scenario로 직접 추가하세요.",
        );
      }
      if (response_format === "json") {
        return ok(
          JSON.stringify(
            state.scenarios.map((s) => ({
              ...s,
              last_result: state.results.get(s.id)
                ? {
                    anomaly_count: state.results.get(s.id)!.anomaly_count,
                    analyzed_at: state.results.get(s.id)!.analyzed_at,
                  }
                : null,
            })),
            null,
            2,
          ),
        );
      }
      const lines: string[] = [`# 등록된 시나리오 (${state.scenarios.length}개)`, ``];
      lines.push(`| ID | 시나리오 | 심각도 | 출처 | 탐지 건수 |`);
      lines.push(`|----|----------|--------|------|-----------|`);
      for (const s of state.scenarios) {
        const r = state.results.get(s.id);
        lines.push(
          `| ${s.id} | ${s.name} (${s.name_en}) | ${severityBadge(s.severity)} | ${s.source} | ${r ? r.anomaly_count : "-"} |`,
        );
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_run_analysis
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_run_analysis",
  {
    title: "Run Anomaly Analysis",
    description: `Run detection scenarios against the loaded card data and return the anomaly summary. Analysis already runs automatically after loading data or generating scenarios — use this tool to re-run manually or to run a subset.

Args:
  - scenario_ids (string[], optional): Scenario IDs to run (e.g. ["S1","S3"]). Omit to run all.
  - response_format ('markdown' | 'json'): default 'markdown'`,
    inputSchema: {
      scenario_ids: z
        .array(z.string())
        .optional()
        .describe('Scenario IDs to run, e.g. ["S1","S3"]. Omit for all.'),
      response_format: responseFormatSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ scenario_ids, response_format }) => {
    try {
      requireDataset();
      const targets = scenario_ids
        ? state.scenarios.filter((s) => scenario_ids.includes(s.id))
        : state.scenarios;
      if (targets.length === 0) {
        throw new Error(
          scenario_ids
            ? `No scenarios match ${JSON.stringify(scenario_ids)}. Use corpcard_list_scenarios to see IDs.`
            : "No scenarios registered. Run corpcard_generate_scenarios first.",
        );
      }
      const results = runScenarios(targets);
      if (response_format === "json") {
        return ok(
          JSON.stringify(
            results.map((r) => ({
              scenario_id: r.scenario_id,
              scenario_name: r.scenario_name,
              severity: r.severity,
              anomaly_count: r.anomaly_count,
              warnings: r.warnings,
            })),
            null,
            2,
          ),
        );
      }
      const total = results.reduce((s, r) => s + r.anomaly_count, 0);
      const lines = [
        `# 분석 완료 — 시나리오 ${results.length}개, 총 탐지 ${total}건`,
        ``,
        ...summarizeResults(results),
        ``,
        `상세 조회: \`corpcard_get_anomalies\`, 보고서: \`corpcard_export_report\``,
      ];
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_get_anomalies
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_get_anomalies",
  {
    title: "Get Anomaly Details",
    description: `Return the detailed anomaly list for one scenario, with pagination.

Args:
  - scenario_id (string): e.g. "S1"
  - limit (number): max items to return, 1-100 (default 20)
  - offset (number): items to skip (default 0)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { scenario_id, total, count, offset, has_more, next_offset, anomalies: [...] }`,
    inputSchema: {
      scenario_id: z.string().describe('Scenario ID, e.g. "S1"'),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      response_format: responseFormatSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ scenario_id, limit, offset, response_format }) => {
    try {
      const result = state.results.get(scenario_id);
      if (!result) {
        throw new Error(
          `No analysis result for "${scenario_id}". Run corpcard_run_analysis first (or check the ID via corpcard_list_scenarios).`,
        );
      }
      const page = result.anomalies.slice(offset, offset + limit);
      const hasMore = offset + page.length < result.anomalies.length;

      if (response_format === "json") {
        return ok(
          JSON.stringify(
            {
              scenario_id,
              scenario_name: result.scenario_name,
              total: result.anomaly_count,
              count: page.length,
              offset,
              has_more: hasMore,
              ...(hasMore ? { next_offset: offset + page.length } : {}),
              anomalies: page,
            },
            null,
            2,
          ),
        );
      }

      const lines: string[] = [];
      lines.push(
        `# ${scenario_id}. ${result.scenario_name} — 탐지 ${result.anomaly_count}건 (표시 ${offset + 1}–${offset + page.length})`,
      );
      lines.push(``);
      page.forEach((a, i) => {
        if (a.type === "row") {
          const rowText = Object.entries(a.row ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          lines.push(`${offset + i + 1}. [행 ${a.row_index}] ${rowText}`);
          lines.push(`   └ 사유: ${a.reason}`);
        } else {
          const keyText = Object.entries(a.group_key ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          lines.push(`${offset + i + 1}. [그룹] ${keyText}`);
          lines.push(
            `   └ ${a.reason} (대상 행: ${(a.row_indices ?? []).join(", ")})`,
          );
        }
      });
      if (hasMore) {
        lines.push(``, `다음 페이지: offset=${offset + page.length}`);
      }
      return ok(truncate(lines.join("\n"), `Lower 'limit' or use offset pagination.`));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: corpcard_export_report
// ---------------------------------------------------------------------------

server.registerTool(
  "corpcard_export_report",
  {
    title: "Export Audit Report",
    description: `Write the full audit report to a file: 'markdown' produces a formatted audit report; 'csv' produces a flat anomaly listing (UTF-8 BOM, Excel-friendly for Korean text).

Args:
  - output_path (string, optional): Where to write the file. Defaults to "corpcard_audit_report.md" / ".csv" next to the loaded data file.
  - format ('markdown' | 'csv'): default 'markdown'

Returns: the absolute path of the written report.`,
    inputSchema: {
      output_path: z.string().optional().describe("Output file path"),
      format: z.enum(["markdown", "csv"]).default("markdown"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ output_path, format }) => {
    try {
      const dataset = requireDataset();
      if (state.scenarios.length === 0) {
        throw new Error("No scenarios to report. Run corpcard_generate_scenarios first.");
      }
      const content =
        format === "csv"
          ? buildCsvExport(dataset, state.scenarios, state.results)
          : buildMarkdownReport(dataset, state.scenarios, state.results);
      const defaultName =
        format === "csv" ? "corpcard_audit_report.csv" : "corpcard_audit_report.md";
      const target = path.resolve(
        output_path ?? path.join(path.dirname(dataset.file_path), defaultName),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      const total = [...state.results.values()].reduce(
        (s, r) => s + r.anomaly_count,
        0,
      );
      return ok(
        `보고서 저장 완료: ${target}\n- 시나리오 ${state.scenarios.length}개, 총 탐지 ${total}건`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    // Not fatal: loading/manual scenarios/reporting work without a key;
    // only corpcard_generate_scenarios requires it.
    console.error(
      "[corpcard-audit-mcp] Warning: ANTHROPIC_API_KEY not set — AI scenario generation will be unavailable.",
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[corpcard-audit-mcp] running on stdio (model: ${resolveModel()})`,
  );
}

main().catch((error) => {
  console.error("[corpcard-audit-mcp] fatal:", error);
  process.exit(1);
});
