import { registerPlugin } from './registry'
import { feishuPlugin } from './feishu'
import { slackPlugin } from './slack'
import { discordPlugin } from './discord'
import { telegramPlugin } from './telegram'
import { dingtalkPlugin } from './dingtalk'
import { wecomPlugin } from './wecom'

registerPlugin(feishuPlugin)
registerPlugin(slackPlugin)
registerPlugin(discordPlugin)
registerPlugin(telegramPlugin)
registerPlugin(dingtalkPlugin)
registerPlugin(wecomPlugin)

export { getPlugin, listPlugins, hasPlugin } from './registry'
export type { ChannelPlugin, ParsedMessage, TestResult } from './types'
