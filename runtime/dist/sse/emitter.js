// One emitter per active runId — registered by Fastify SSE handler, consumed by agent runner
const channels = new Map();
export function registerChannel(runId, emit) {
    channels.set(runId, emit);
}
export function getChannel(runId) {
    return channels.get(runId);
}
export function removeChannel(runId) {
    channels.delete(runId);
}
export function formatSseData(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
}
