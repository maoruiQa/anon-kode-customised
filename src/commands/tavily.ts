import type { Command } from '../commands'
import { TavilyTool } from '../tools/TavilyTool/TavilyTool'

function parseArgs(args: string): {
  query: string
} {
  const trimmed = (args || '').trim()
  if (!trimmed) {
    throw new Error('Usage: /tavily <query>')
  }
  // support JSON input for power users: /tavily {"query":"..."}
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if (!obj.query || typeof obj.query !== 'string') {
        throw new Error('Missing "query" in JSON input')
      }
      return { query: obj.query }
    } catch (e) {
      throw new Error(`Invalid JSON input: ${(e as Error).message}`)
    }
  }
  return { query: trimmed }
}

const command: Command = {
  name: 'tavily',
  description: 'Run a web search using the Tavily tool',
  isEnabled: true,
  isHidden: false,
  type: 'local',
  userFacingName() {
    return this.name
  },
  async call(args, { abortController }) {
    // Ensure tool is enabled (API key + toggle)
    if (!(await TavilyTool.isEnabled())) {
      return 'Tavily is not enabled. Run /tavily-config to open the Tavily settings and set your API key, or use /config to adjust settings.'
    }

    let input
    try {
      input = parseArgs(args)
    } catch (e) {
      return (e as Error).message
    }

    try {
      const gen = (TavilyTool.call as any)(input, { abortController })
      let last: any
      for await (const ev of gen) {
        if (ev?.type === 'result') {
          last = ev
        }
      }
      if (!last) return 'No results'
      const text = TavilyTool.renderResultForAssistant(last.data)
      return text || 'No results'
    } catch (e) {
      return `Error: ${(e as Error).message}`
    }
  },
}

export default command
