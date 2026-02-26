import type { ChannelPlugin } from './types'

const registry = new Map<string, ChannelPlugin>()

export function registerPlugin(plugin: ChannelPlugin): void {
  registry.set(plugin.type, plugin)
}

export function getPlugin(type: string): ChannelPlugin {
  const plugin = registry.get(type)
  if (!plugin) {
    throw Object.assign(new Error(`Unsupported channel type: ${type}`), { code: 'INVALID_ARGUMENT' })
  }
  return plugin
}

export function listPlugins(): ChannelPlugin[] {
  return Array.from(registry.values())
}

export function hasPlugin(type: string): boolean {
  return registry.has(type)
}
