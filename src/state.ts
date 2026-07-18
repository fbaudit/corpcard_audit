/**
 * In-memory session state. An MCP stdio server lives for one client session,
 * so a module-level singleton is the whole persistence story — the exported
 * report (corpcard_export_report) is the durable artifact.
 */
import type { Dataset, Scenario, ScenarioResult } from "./types.js";

interface SessionState {
  dataset: Dataset | null;
  scenarios: Scenario[];
  results: Map<string, ScenarioResult>;
  scenarioSeq: number;
}

export const state: SessionState = {
  dataset: null,
  scenarios: [],
  results: new Map(),
  scenarioSeq: 0,
};

export function nextScenarioId(): string {
  state.scenarioSeq += 1;
  return `S${state.scenarioSeq}`;
}

export function requireDataset(): Dataset {
  if (!state.dataset) {
    throw new Error(
      "No card data loaded yet. Call corpcard_load_data with a CSV/XLSX file path first.",
    );
  }
  return state.dataset;
}
