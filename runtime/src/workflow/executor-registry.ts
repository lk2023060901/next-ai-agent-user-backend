import type { NodeExecutor } from './types.js'
import { textExecutor } from './executors/text.js'
import { conditionExecutor } from './executors/condition.js'
import { loopExecutor } from './executors/loop.js'
import { llmCallExecutor } from './executors/llm-call.js'
import { variableSetExecutor, variableGetExecutor } from './executors/variable.js'
import { jsonTransformExecutor } from './executors/json-transform.js'
import { httpRequestExecutor } from './executors/http-request.js'
import { codeExecuteExecutor } from './executors/code-execute.js'
import { kbSearchExecutor } from './executors/kb-search.js'
import { sendMessageExecutor } from './executors/send-message.js'

const executors = new Map<string, NodeExecutor>()

executors.set('text', textExecutor)
executors.set('condition', conditionExecutor)
executors.set('loop', loopExecutor)
executors.set('llm-call', llmCallExecutor)
executors.set('variable-set', variableSetExecutor)
executors.set('variable-get', variableGetExecutor)
executors.set('json-transform', jsonTransformExecutor)
executors.set('http-request', httpRequestExecutor)
executors.set('code-execute', codeExecuteExecutor)
executors.set('kb-search', kbSearchExecutor)
executors.set('send-message', sendMessageExecutor)
// 'comment' has no executor — it's not executed

export function getExecutor(typeId: string): NodeExecutor | undefined {
  return executors.get(typeId)
}
