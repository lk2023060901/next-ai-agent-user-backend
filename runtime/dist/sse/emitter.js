export function formatSseData(event) {
    const idLine = typeof event.seq === "number" && Number.isFinite(event.seq) ? `id: ${event.seq}\n` : "";
    return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}
