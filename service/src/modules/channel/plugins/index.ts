import { registerPlugin } from './registry.js'
import { feishuPlugin } from './feishu.js'
import { slackPlugin } from './slack.js'
import { discordPlugin } from './discord.js'
import { telegramPlugin } from './telegram.js'
import { dingtalkPlugin } from './dingtalk.js'
import { wecomPlugin } from './wecom.js'

registerPlugin(feishuPlugin)
registerPlugin(slackPlugin)
registerPlugin(discordPlugin)
registerPlugin(telegramPlugin)
registerPlugin(dingtalkPlugin)
registerPlugin(wecomPlugin)

export { getPlugin, listPlugins, hasPlugin } from './registry.js'
export type { ChannelPlugin, ParsedMessage, TestResult } from './types.js'
