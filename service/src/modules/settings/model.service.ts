import {
  deleteRuntimeModel,
  runtimeFlatModels,
  runtimeModelCatalogSeries,
  runtimeModelSeries,
  upsertRuntimeModel,
  updateRuntimeModel,
} from "./runtime-provider.service.js";

// ─── View types ───────────────────────────────────────────────────────────────

export interface UIModelView {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  enabled: boolean;
}

export interface ModelSeriesView {
  id: string;
  name: string;
  models: UIModelView[];
}

interface LegacyModelRow {
  id: string;
  providerId: string;
  name: string;
  contextWindow: number | null;
  costPer1kTokens: number | null;
  isDefault: boolean;
}

function toLegacyModelRow(model: {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice: number;
}, providerId: string): LegacyModelRow {
  return {
    id: model.id,
    providerId,
    name: model.name,
    contextWindow: model.contextWindow,
    costPer1kTokens: model.inputPrice,
    isDefault: false,
  };
}

function toUiSeries(
  rows: Array<{ id: string; name: string; models: Array<{
    id: string;
    name: string;
    displayName: string;
    contextWindow: number;
    maxOutput: number;
    inputPrice: number;
    outputPrice: number;
    capabilities: string[];
    enabled: boolean;
  }> }>,
): ModelSeriesView[] {
  return rows.map((series) => ({
    id: series.id,
    name: series.name,
    models: series.models.map((model) => ({
      id: model.id,
      name: model.name,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
      capabilities: model.capabilities,
      enabled: model.enabled,
    })),
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function listModels(workspaceId: string, providerId: string): LegacyModelRow[] {
  const rows = runtimeModelSeries(workspaceId, providerId)
    .flatMap((series) => series.models)
    .map((model) => toLegacyModelRow(model, providerId));
  return rows;
}

export function listAllModels(workspaceId: string): LegacyModelRow[] {
  return runtimeFlatModels(workspaceId).map((row) => ({
    id: row.modelId,
    providerId: row.providerId,
    name: row.name,
    contextWindow: row.contextWindow,
    costPer1kTokens: row.inputPrice,
    isDefault: false,
  }));
}

export function createModel(data: {
  workspaceId: string;
  providerId: string;
  name: string;
  contextWindow?: number;
  costPer1kTokens?: number;
  isDefault?: boolean;
}) {
  const model = upsertRuntimeModel(data.workspaceId, data.providerId, {
    name: data.name,
    contextWindow: data.contextWindow,
    costPer1kTokens: data.costPer1kTokens,
    enabled: true,
  });

  return toLegacyModelRow(model, data.providerId);
}

export function updateModel(
  workspaceId: string,
  id: string,
  data: {
    name?: string;
    contextWindow?: number;
    costPer1kTokens?: number;
    isDefault?: boolean;
  },
) {
  const model = updateRuntimeModel(workspaceId, id, data);
  const flat = runtimeFlatModels(workspaceId).find((row) => row.modelId === model.id || row.name === model.name);
  const providerId = flat?.providerId ?? (id.startsWith("static:") ? id.split(":")[1] || "" : "");
  return toLegacyModelRow(model, providerId);
}

export function deleteModel(workspaceId: string, id: string) {
  deleteRuntimeModel(workspaceId, id);
}

export function listModelSeries(workspaceId: string, providerId: string): ModelSeriesView[] {
  return toUiSeries(runtimeModelSeries(workspaceId, providerId));
}

export function listModelCatalog(workspaceId: string, providerId: string): ModelSeriesView[] {
  const _workspaceId = workspaceId;
  return toUiSeries(runtimeModelCatalogSeries(providerId));
}
