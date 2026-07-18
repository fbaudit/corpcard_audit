/**
 * Report rendering: markdown audit report and CSV anomaly export.
 */
import type { Dataset, Scenario, ScenarioResult } from "./types.js";

const REPORT_ROW_LIMIT = 30;

const SEVERITY_LABEL: Record<string, string> = {
  high: "🔴 High",
  medium: "🟠 Medium",
  low: "🟡 Low",
};

export function buildMarkdownReport(
  dataset: Dataset,
  scenarios: Scenario[],
  results: Map<string, ScenarioResult>,
): string {
  const lines: string[] = [];
  lines.push(`# 법인카드 이상징후 탐지 보고서 (Corporate Card Anomaly Report)`);
  lines.push(``);
  lines.push(`- **데이터 파일**: ${dataset.file_path}`);
  lines.push(`- **분석 대상 거래 건수**: ${dataset.rows.length.toLocaleString()}`);
  lines.push(`- **적용 시나리오 수**: ${scenarios.length}`);
  lines.push(`- **보고서 생성 시각**: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## 요약 (Summary)`);
  lines.push(``);
  lines.push(`| ID | 시나리오 | 심각도 | 탐지 건수 |`);
  lines.push(`|----|----------|--------|-----------|`);
  for (const s of scenarios) {
    const r = results.get(s.id);
    lines.push(
      `| ${s.id} | ${s.name} | ${SEVERITY_LABEL[s.severity] ?? s.severity} | ${r ? r.anomaly_count.toLocaleString() : "미실행"} |`,
    );
  }
  lines.push(``);

  for (const s of scenarios) {
    const r = results.get(s.id);
    lines.push(`## ${s.id}. ${s.name} (${s.name_en})`);
    lines.push(``);
    lines.push(`- **심각도**: ${SEVERITY_LABEL[s.severity] ?? s.severity}`);
    lines.push(`- **설명**: ${s.description}`);
    lines.push(`- **감사 근거**: ${s.audit_rationale}`);
    if (!r) {
      lines.push(`- **결과**: 아직 분석되지 않음 (corpcard_run_analysis 실행 필요)`);
      lines.push(``);
      continue;
    }
    lines.push(`- **탐지 건수**: ${r.anomaly_count.toLocaleString()}`);
    for (const w of r.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push(``);
    if (r.anomalies.length > 0) {
      lines.push(...renderAnomalyTable(dataset, r));
      if (r.anomaly_count > REPORT_ROW_LIMIT) {
        lines.push(
          `_상위 ${REPORT_ROW_LIMIT}건만 표시 (전체 ${r.anomaly_count}건은 CSV 내보내기 참조)_`,
        );
      }
      lines.push(``);
    }
  }
  return lines.join("\n");
}

function renderAnomalyTable(dataset: Dataset, r: ScenarioResult): string[] {
  const lines: string[] = [];
  const sample = r.anomalies.slice(0, REPORT_ROW_LIMIT);
  const isRow = sample[0]?.type === "row";
  if (isRow) {
    lines.push(`| # | ${dataset.headers.map(esc).join(" | ")} | 사유 |`);
    lines.push(`|---|${dataset.headers.map(() => "---").join("|")}|---|`);
    for (const a of sample) {
      const cells = dataset.headers.map((h) => esc(a.row?.[h] ?? ""));
      lines.push(`| ${a.row_index} | ${cells.join(" | ")} | ${esc(a.reason)} |`);
    }
  } else {
    const keyFields = Object.keys(sample[0]?.group_key ?? {});
    lines.push(`| ${keyFields.map(esc).join(" | ")} | 값 | 대상 행 | 사유 |`);
    lines.push(`|${keyFields.map(() => "---").join("|")}|---|---|---|`);
    for (const a of sample) {
      const cells = keyFields.map((k) => esc(a.group_key?.[k] ?? ""));
      lines.push(
        `| ${cells.join(" | ")} | ${a.metric_value ?? ""} | ${(a.row_indices ?? []).join(", ")} | ${esc(a.reason)} |`,
      );
    }
  }
  return lines;
}

export function buildCsvExport(
  dataset: Dataset,
  scenarios: Scenario[],
  results: Map<string, ScenarioResult>,
): string {
  const header = [
    "scenario_id",
    "scenario_name",
    "severity",
    "anomaly_type",
    "row_index",
    "group_key",
    "metric_value",
    "reason",
    ...dataset.headers,
  ];
  const rows: string[] = [header.map(csvCell).join(",")];
  for (const s of scenarios) {
    const r = results.get(s.id);
    if (!r) continue;
    for (const a of r.anomalies) {
      rows.push(
        [
          s.id,
          s.name,
          s.severity,
          a.type,
          a.row_index ?? "",
          a.group_key ? JSON.stringify(a.group_key) : "",
          a.metric_value ?? "",
          a.reason,
          ...dataset.headers.map((h) => a.row?.[h] ?? ""),
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  // BOM so Korean text opens correctly in Excel.
  return "﻿" + rows.join("\r\n");
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function esc(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
