import {
  createRuntimeProvider,
  deleteRuntimeProvider,
  listRuntimeProviders,
  testRuntimeProvider,
  updateRuntimeProvider,
} from "./runtime-provider.service.js";

export function normalizeProviderType(raw: string | undefined | null): string {
  return (raw ?? "").trim().toLowerCase();
}

export function listProviders(workspaceId: string) {
  return listRuntimeProviders(workspaceId);
}

export function createProvider(data: {
  workspaceId: string;
  name: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  return createRuntimeProvider(data);
}

export function updateProvider(
  workspaceId: string,
  id: string,
  data: { name?: string; apiKey?: string; baseUrl?: string; status?: string },
) {
  return updateRuntimeProvider(workspaceId, id, data);
}

export function deleteProvider(workspaceId: string, id: string) {
  return deleteRuntimeProvider(workspaceId, id);
}

export async function testProvider(workspaceId: string, id: string): Promise<{ success: boolean; message: string }> {
  return testRuntimeProvider(workspaceId, id);
}
