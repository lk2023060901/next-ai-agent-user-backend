import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { db } from "../../db";
import { channels, channelMessages, routingRules } from "../../db/schema";

// ─── Channel CRUD ─────────────────────────────────────────────────────────────

export function listChannels(workspaceId: string) {
  return db.select().from(channels).where(eq(channels.workspaceId, workspaceId)).all();
}

export function getChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch) throw Object.assign(new Error("Channel not found"), { code: "NOT_FOUND" });
  return ch;
}

export function createChannel(data: {
  workspaceId: string;
  name: string;
  type: string;
  configJson?: string;
}) {
  const id = uuidv4();
  db.insert(channels).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: data.type,
    configJson: data.configJson ?? "{}",
  }).run();
  return db.select().from(channels).where(eq(channels.id, id)).get()!;
}

export function updateChannel(channelId: string, data: {
  name?: string;
  status?: string;
  configJson?: string;
}) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch) throw Object.assign(new Error("Channel not found"), { code: "NOT_FOUND" });

  db.update(channels).set({
    ...(data.name && { name: data.name }),
    ...(data.status && { status: data.status }),
    ...(data.configJson !== undefined && { configJson: data.configJson }),
    updatedAt: new Date().toISOString(),
  }).where(eq(channels.id, channelId)).run();

  return db.select().from(channels).where(eq(channels.id, channelId)).get()!;
}

export function deleteChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch) throw Object.assign(new Error("Channel not found"), { code: "NOT_FOUND" });
  db.delete(channels).where(eq(channels.id, channelId)).run();
}

// ─── Routing Rules ────────────────────────────────────────────────────────────

export function listRoutingRules(channelId: string) {
  return db.select().from(routingRules).where(eq(routingRules.channelId, channelId)).all();
}

export function createRoutingRule(data: {
  channelId: string;
  field: string;
  operator: string;
  value?: string;
  targetAgentId?: string;
  priority?: number;
}) {
  const id = uuidv4();
  db.insert(routingRules).values({
    id,
    channelId: data.channelId,
    field: data.field,
    operator: data.operator,
    value: data.value ?? null,
    targetAgentId: data.targetAgentId ?? null,
    priority: data.priority ?? 0,
  }).run();
  return db.select().from(routingRules).where(eq(routingRules.id, id)).get()!;
}

export function updateRoutingRule(ruleId: string, data: {
  field?: string;
  operator?: string;
  value?: string;
  targetAgentId?: string;
  priority?: number;
  enabled?: boolean;
}) {
  const rule = db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get();
  if (!rule) throw Object.assign(new Error("Routing rule not found"), { code: "NOT_FOUND" });

  db.update(routingRules).set({
    ...(data.field && { field: data.field }),
    ...(data.operator && { operator: data.operator }),
    ...(data.value !== undefined && { value: data.value }),
    ...(data.targetAgentId !== undefined && { targetAgentId: data.targetAgentId }),
    ...(data.priority !== undefined && { priority: data.priority }),
    ...(data.enabled !== undefined && { enabled: data.enabled }),
  }).where(eq(routingRules.id, ruleId)).run();

  return db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get()!;
}

export function deleteRoutingRule(ruleId: string) {
  const rule = db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get();
  if (!rule) throw Object.assign(new Error("Routing rule not found"), { code: "NOT_FOUND" });
  db.delete(routingRules).where(eq(routingRules.id, ruleId)).run();
}

// ─── Webhook Handling ─────────────────────────────────────────────────────────

export function handleWebhook(channelId: string, body: string, headers: Record<string, string>) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!ch || ch.status !== "active") {
    return { accepted: false, message: "Channel not found or inactive" };
  }

  let config: Record<string, string> = {};
  try { config = JSON.parse(ch.configJson ?? "{}"); } catch {}

  // Verify signature based on channel type
  if (!verifySignature(ch.type, body, headers, config)) {
    return { accepted: false, message: "Invalid signature" };
  }

  // Parse message content
  const content = extractContent(ch.type, body);

  // Store inbound message
  const msgId = uuidv4();
  db.insert(channelMessages).values({
    id: msgId,
    channelId,
    direction: "inbound",
    sender: extractSender(ch.type, body),
    content,
    status: "received",
  }).run();

  // Match routing rules (sorted by priority desc)
  const rules = db
    .select()
    .from(routingRules)
    .where(eq(routingRules.channelId, channelId))
    .all()
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const matchedRule = rules.find((rule) => matchRule(rule, content));

  // TODO: dispatch to Agent when chat module is implemented
  console.log(`Webhook received for channel ${channelId}, matched rule: ${matchedRule?.id ?? "none"}`);

  return { accepted: true, message: "ok" };
}

function verifySignature(
  type: string,
  body: string,
  headers: Record<string, string>,
  config: Record<string, string>
): boolean {
  switch (type) {
    case "slack": {
      const secret = config.signing_secret;
      if (!secret) return true; // skip if not configured
      const ts = headers["x-slack-request-timestamp"];
      const sig = headers["x-slack-signature"];
      if (!ts || !sig) return false;
      const base = `v0:${ts}:${body}`;
      const expected = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    }
    case "telegram":
      return true; // Telegram uses token in URL path
    default:
      return true; // permissive for unknown types
  }
}

function extractContent(type: string, body: string): string {
  try {
    const parsed = JSON.parse(body);
    switch (type) {
      case "slack": return parsed.event?.text ?? parsed.text ?? body;
      case "telegram": return parsed.message?.text ?? body;
      case "discord": return parsed.content ?? body;
      default: return body;
    }
  } catch { return body; }
}

function extractSender(type: string, body: string): string {
  try {
    const parsed = JSON.parse(body);
    switch (type) {
      case "slack": return parsed.event?.user ?? parsed.user_id ?? "unknown";
      case "telegram": return String(parsed.message?.from?.id ?? "unknown");
      case "discord": return parsed.author?.id ?? "unknown";
      default: return "unknown";
    }
  } catch { return "unknown"; }
}

function matchRule(rule: typeof routingRules.$inferSelect, content: string): boolean {
  const val = rule.value ?? "";
  switch (rule.operator) {
    case "contains": return content.includes(val);
    case "starts_with": return content.startsWith(val);
    case "equals": return content === val;
    case "regex": try { return new RegExp(val).test(content); } catch { return false; }
    default: return false;
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function listChannelMessages(channelId: string, limit = 50) {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .all()
    .slice(-limit);
}
