import { registerPlugin } from './registry'
import { feishuPlugin } from './feishu'
import { slackPlugin } from './slack'
import { discordPlugin } from './discord'
import { telegramPlugin } from './telegram'
import { webchatPlugin } from './webchat'

registerPlugin(feishuPlugin)
registerPlugin(slackPlugin)
registerPlugin(discordPlugin)
registerPlugin(telegramPlugin)
registerPlugin(webchatPlugin)

export { getPlugin, listPlugins, hasPlugin } from './registry'
export type { ChannelPlugin, ParsedMessage, TestResult } from './types'
