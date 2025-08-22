import React from 'react'
import { z } from 'zod'
import { getGlobalConfig } from '../../utils/config'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage'
import { Box, Text } from 'ink'
import { Cost } from '../../components/Cost'
import { ProxyAgent, fetch } from 'undici'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  query: z.string().min(1).describe('The web search query.'),
  searchDepth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('Search depth. Defaults to "basic".'),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Maximum number of results to return (<= 20).'),
  includeDomains: z
    .array(z.string())
    .optional()
    .describe('Domains to include in the search.'),
  excludeDomains: z
    .array(z.string())
    .optional()
    .describe('Domains to exclude from the search.'),
  includeAnswer: z
    .boolean()
    .optional()
    .describe('If true, include Tavily\'s synthesized answer.'),
  includeRawContent: z
    .boolean()
    .optional()
    .describe('If true, include raw page content in results.'),
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Limit results to the last N days.'),
})

// Types based on Tavily response shape
// See https://docs.tavily.com/ for full schema; we keep it permissive.
type Input = typeof inputSchema

type TavilyResultItem = {
  title?: string
  url?: string
  content?: string
  score?: number
  published_date?: string
}

type TavilyResponse = {
  answer?: string
  query?: string
  results?: TavilyResultItem[]
  images?: string[]
  follow_up_questions?: string[]
  // Allow unknown extra fields
  [k: string]: any
}

type Output = {
  durationMs: number
  summaryForAssistant: string
  response: TavilyResponse
}

export const TavilyTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Web Search (Tavily)'
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  async isEnabled() {
    const cfg = getGlobalConfig()
    return Boolean((cfg.tavilyEnabled ?? true) && cfg.tavilyApiKey)
  },
  needsPermissions() {
    // Network-only, rely on global allowedTools gating
    return false
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(
    { query, searchDepth, maxResults, includeDomains, excludeDomains, includeAnswer, includeRawContent, days },
    { verbose },
  ) {
    const parts: string[] = [`query: "${query}"`]
    if (searchDepth) parts.push(`searchDepth: ${searchDepth}`)
    if (typeof maxResults === 'number') parts.push(`maxResults: ${maxResults}`)
    if (includeDomains?.length) parts.push(`includeDomains: ${includeDomains.join(',')}`)
    if (excludeDomains?.length) parts.push(`excludeDomains: ${excludeDomains.join(',')}`)
    if (typeof includeAnswer === 'boolean') parts.push(`includeAnswer: ${includeAnswer}`)
    if (typeof includeRawContent === 'boolean') parts.push(`includeRawContent: ${includeRawContent}`)
    if (typeof days === 'number') parts.push(`days: ${days}`)
    return parts.join(', ')
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output) {
    const out = output as Output
    const num = out.response?.results?.length ?? 0
    return (
      <Box justifyContent="space-between" width="100%">
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;Found </Text>
          <Text bold>{num} </Text>
          <Text>{num === 1 ? 'result' : 'results'}</Text>
        </Box>
        <Cost costUSD={0} durationMs={out.durationMs} debug={false} />
      </Box>
    )
  },
  renderResultForAssistant({ response }: Output) {
    const lines: string[] = []
    if (response?.answer) {
      lines.push(`Answer: ${response.answer}`)
    }
    const results = response?.results ?? []
    if (results.length) {
      lines.push('Top results:')
      for (const r of results.slice(0, 5)) {
        const t = r.title || '(no title)'
        const u = r.url || ''
        lines.push(`- ${t}${u ? ` \u003c${u}\u003e` : ''}`)
      }
    }
    return lines.join('\n') || 'No results'
  },
  async *call(
    { query, searchDepth, maxResults, includeDomains, excludeDomains, includeAnswer, includeRawContent, days },
    { abortController },
  ) {
    const start = Date.now()
    const cfg = getGlobalConfig()
    const apiKey = cfg.tavilyApiKey
    if (!apiKey) {
      throw new Error('Tavily API key not set. Please configure it in Settings.')
    }

    const proxy = cfg.proxy ? new ProxyAgent(cfg.proxy) : undefined

    const body: Record<string, any> = {
      query,
    }
    if (searchDepth) body.search_depth = searchDepth
    if (typeof maxResults === 'number') body.max_results = maxResults
    if (includeDomains?.length) body.include_domains = includeDomains
    if (excludeDomains?.length) body.exclude_domains = excludeDomains
    if (typeof includeAnswer === 'boolean') body.include_answer = includeAnswer
    if (typeof includeRawContent === 'boolean') body.include_raw_content = includeRawContent
    if (typeof days === 'number') body.days = days

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      dispatcher: proxy,
      signal: abortController?.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Tavily request failed: ${res.status} ${res.statusText} - ${text}`)
    }

    const response = (await res.json()) as TavilyResponse

    const output: Output = {
      durationMs: Date.now() - start,
      summaryForAssistant: '', // not used directly; we compute via renderResultForAssistant
      response,
    }

    yield {
      type: 'result' as const,
      resultForAssistant: this.renderResultForAssistant(output),
      data: output,
    }
  },
}
