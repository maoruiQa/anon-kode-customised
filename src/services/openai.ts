import OpenAI from "openai";
import { getGlobalConfig, GlobalConfig } from "../utils/config";
import { ProxyAgent, fetch, Response } from 'undici'
import { setSessionState, getSessionState } from "../utils/sessionState";
import { logEvent } from "../services/statsig";

enum ModelErrorType {
  MaxLength = '1024',
  MaxCompletionTokens = 'max_completion_tokens',
  StreamOptions = 'stream_options',
  Citations = 'citations',
  RateLimit = 'rate_limit',
  StreamingUnsupported = 'streaming_unsupported'
}

function getModelErrorKey(baseURL: string, model: string, type: ModelErrorType): string {
  return `${baseURL}:${model}:${type}`
}

function hasModelError(baseURL: string, model: string, type: ModelErrorType): boolean {
  return !!getSessionState('modelErrors')[getModelErrorKey(baseURL, model, type)]
}

function setModelError(baseURL: string, model: string, type: ModelErrorType, error: string) {
  setSessionState('modelErrors', {
    [getModelErrorKey(baseURL, model, type)]: error
  })
}

// More flexible error detection system
type ErrorDetector = (errMsg: string) => boolean;
type ErrorFixer = (opts: OpenAI.ChatCompletionCreateParams) => Promise<void> | void;
type RateLimitHandler = (
  opts: OpenAI.ChatCompletionCreateParams, 
  response: Response, 
  type: 'large' | 'small',
  config: GlobalConfig,
  attempt: number, 
  maxAttempts: number
) => Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>>;

interface ErrorHandler {
  type: ModelErrorType;
  detect: ErrorDetector;
  fix: ErrorFixer;
}

// Specialized handler for rate limiting
const handleRateLimit: RateLimitHandler = async (opts, response, type, config, attempt, maxAttempts) => {
  const retryAfter = response?.headers.get('retry-after');
  const delay = retryAfter && !isNaN(parseInt(retryAfter)) ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
  logEvent('rate_limited', {
    delay: String(delay),
    attempt: String(attempt),
    maxAttempts: String(maxAttempts)
  })
  setSessionState('currentError', `(${attempt} / ${maxAttempts}) Rate limited. Retrying in ${delay / 1000} seconds...`)
  await new Promise(resolve => setTimeout(resolve, delay));
  return getCompletion(type, opts, attempt + 1, maxAttempts);
};

// Standard error handlers
const ERROR_HANDLERS: ErrorHandler[] = [
  { 
    type: ModelErrorType.MaxLength, 
    detect: (errMsg) => errMsg.includes('Expected a string with maximum length 1024'),
    fix: async (opts) => {
      const toolDescriptions = {}
      for(const tool of opts.tools || []) {
        if(tool.function.description.length <= 1024) continue
        let str = ''
        let remainder = ''
        for(let line of tool.function.description.split('\n')) {
          if(str.length + line.length < 1024) {
            str += line + '\n'
          } else {
            remainder += line + '\n'
          }
        }
        logEvent('truncated_tool_description', {
          name: tool.function.name,
          original_length: String(tool.function.description.length),
          truncated_length: String(str.length),
          remainder_length: String(remainder.length),
        })
        tool.function.description = str
        toolDescriptions[tool.function.name] = remainder
      }
      if(Object.keys(toolDescriptions).length > 0) {
        let content = '<additional-tool-usage-instructions>\n\n'
        for(const [name, description] of Object.entries(toolDescriptions)) {
          content += `<${name}>\n${description}\n</${name}>\n\n`
        }
        content += '</additional-tool-usage-instructions>'

        for(let i = opts.messages.length - 1; i >= 0; i--) {
          if(opts.messages[i].role === 'system') {
            opts.messages.splice(i + 1, 0, {
              role: 'system',
              content
            })
            break
          }
        }
      }
    }
  },
  { 
    type: ModelErrorType.MaxCompletionTokens, 
    detect: (errMsg) => errMsg.includes("Use 'max_completion_tokens'"),
    fix: async (opts) => {
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    }
  },
  { 
    type: ModelErrorType.StreamOptions, 
    detect: (errMsg) => errMsg.includes('Extra inputs are not permitted') && errMsg.includes('stream_options'),
    fix: async (opts) => {
      delete opts.stream_options
    }
  },
  { 
    type: ModelErrorType.Citations, 
    detect: (errMsg) => errMsg.includes('Extra inputs are not permitted') && errMsg.includes('citations'),
    fix: async (opts) => {
      if (!opts.messages) return;
      
      for (const message of opts.messages) {
        if (!message) continue;
        
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            // Convert to unknown first to safely access properties
            if (item && typeof item === 'object') {
              const itemObj = item as unknown as Record<string, unknown>;
              if ('citations' in itemObj) {
                delete itemObj.citations;
              }
            }
          }
        } else if (message.content && typeof message.content === 'object') {
          // Convert to unknown first to safely access properties
          const contentObj = message.content as unknown as Record<string, unknown>;
          if ('citations' in contentObj) {
            delete contentObj.citations;
          }
        }
      }
    }
  },
  {
    type: ModelErrorType.StreamingUnsupported,
    detect: (errMsg) => {
      if (!errMsg) return false
      const lower = errMsg.toLowerCase()
      // Common server-side streaming failure from Python servers (FastAPI/Starlette)
      return (
        lower.includes('body_iterator') ||
        lower.includes('stream error') ||
        lower.includes('streamingresponse') ||
        lower.includes('server-sent events')
      )
    },
    fix: async (opts) => {
      // Disable streaming and remove unsupported options
      // so we can retry with a regular (non-SSE) response
      delete (opts as any).stream_options
      ;(opts as any).stream = false
    },
  },
];

// Rate limit specific detection
function isRateLimitError(errMsg: string): boolean {
  if (!errMsg) return false;
  const lowerMsg = errMsg.toLowerCase();
  return lowerMsg.includes('rate limit') || lowerMsg.includes('too many requests') || lowerMsg.includes('429');
}

async function applyModelErrorFixes(opts: OpenAI.ChatCompletionCreateParams, baseURL: string) {
  for (const handler of ERROR_HANDLERS) {
    if (hasModelError(baseURL, opts.model, handler.type)) {
      await handler.fix(opts);
      return;
    }
  }
}

async function handleApiError(
  response: Response,
  error: any,
  type: 'large' | 'small',
  opts: OpenAI.ChatCompletionCreateParams,
  config: GlobalConfig,
  attempt: number,
  maxAttempts: number
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  let errMsg = error.error?.message || error.message || error;
  if (errMsg) {
    if (typeof errMsg !== 'string') {
      errMsg = JSON.stringify(errMsg);
    }
    // Check for rate limiting first
    if (isRateLimitError(errMsg)) {
      logEvent('rate_limit_error', {
        error_message: errMsg
      })
      return handleRateLimit(opts, response, type, config, attempt, maxAttempts);
    }

    // Handle other errors
    const baseURL = type === 'large' ? config.largeModelBaseURL : config.smallModelBaseURL;

    for (const handler of ERROR_HANDLERS) {
      if (handler.detect(errMsg)) {
        logEvent('model_error', {
          model: opts.model,
          error: handler.type,
          error_message: errMsg
        })
        setSessionState('currentError', `(${attempt} / ${maxAttempts}) Error: ${handler.type}. Retrying...`)
        setModelError(baseURL, opts.model, handler.type, errMsg);
        return getCompletion(type, opts, attempt + 1, maxAttempts);
      }
    }
  }
  
  // If we get here, it's an unhandled error
  logEvent('unhandled_api_error', {
    model: opts.model,
    error: errMsg,
    error_message: errMsg
  })
  
  throw new Error(`API request failed: ${error.error?.message || JSON.stringify(error)}`);
}

// Convert a non-stream ChatCompletion into a simple one-chunk stream
function convertCompletionToStream(
  completion: OpenAI.ChatCompletion,
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  return (async function* () {
    try {
      const choice = completion.choices?.[0]
      const content = choice?.message?.content ?? ''
      const tool_calls_full = choice?.message?.tool_calls ?? undefined

      const chunk: OpenAI.ChatCompletionChunk = {
        id: completion.id || 'synthetic',
        object: 'chat.completion.chunk',
        created: completion.created || Math.floor(Date.now() / 1000),
        model: completion.model || 'unknown',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: (typeof content === 'string') ? content : undefined,
              // Emit tool_calls in streaming delta format with indices so reducer can rebuild
              ...(Array.isArray(tool_calls_full)
                ? {
                    tool_calls: tool_calls_full.map((tc: any, i: number) => ({
                      index: i,
                      id: tc.id,
                      type: tc.type || 'function',
                      function: {
                        name: tc.function?.name,
                        arguments: tc.function?.arguments,
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: 'stop',
            logprobs: null as any,
          },
        ],
        // Provide usage if available so downstream can compute costs
        usage: (completion as any).usage,
      }
      yield chunk
    } catch (e) {
      console.error('Error converting completion to stream:', (e as any)?.message ?? e)
      throw e
    }
  })()
}

export async function getCompletion(
  type: 'large' | 'small', 
  opts: OpenAI.ChatCompletionCreateParams,
  attempt: number = 0,
  maxAttempts: number = 5
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  if (attempt >= maxAttempts) {
    throw new Error('Max attempts reached')
  }
  const config = getGlobalConfig()
  const apiKey = type === 'large' ? config.largeModelApiKey : config.smallModelApiKey
  const baseURL = type === 'large' ? config.largeModelBaseURL : config.smallModelBaseURL
  const proxy = config.proxy ? new ProxyAgent(config.proxy) : undefined
  logEvent('get_completion', {
    messages: JSON.stringify(opts.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 100) : (m.content ? JSON.stringify(m.content?.map(c => ({
        type: c.type,
        text: c.text?.slice(0, 100)
      }))) : '')
    })))
  })
  opts = structuredClone(opts)

  await applyModelErrorFixes(opts, baseURL)

  if (config.primaryProvider === 'custom') {
    opts.messages = opts.messages.map(msg => {
      if (msg.role === 'tool' && 
          Array.isArray(msg.content)
        ) {
        return {
          ...msg,
          content: msg.content.map(c => c.text).join('\n\n')
        };
      }
      return msg;
    });
  }

  const handleResponse = async (response: Response) => {
    try {
      let responseData: any
      if(response.ok) {
        responseData = await response.json() as any
        if(responseData?.response?.includes('429')) {
          return handleRateLimit(opts, response, type, config, attempt, maxAttempts)
        }
        return responseData
      } else {
        const error = await response.json() as { error?: { message: string }, message?: string }
        return handleApiError(response, error, type, opts, config, attempt, maxAttempts)
      }
    } catch (jsonError) {
      // If we can't parse the error as JSON, use the status text
      return handleApiError(
        response, 
        { error: { message: `HTTP error ${response.status}: ${response.statusText}` }}, 
        type, opts, config, attempt, maxAttempts
      )
    }
  }

  try {
    if (opts.stream) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...opts, stream: true }),
        dispatcher: proxy,
      })
      
      if (!response.ok) {
        // Try to capture the full error body (JSON or text) to detect server messages like 'body_iterator'
        const rawText = await response.text().catch(() => '')
        try {
          const parsed = rawText ? JSON.parse(rawText) : undefined
          const error = (parsed ?? { error: { message: rawText || `HTTP error ${response.status}: ${response.statusText}` } }) as { error?: { message: string }, message?: string }
          return handleApiError(response, error, type, opts, config, attempt, maxAttempts)
        } catch {
          return handleApiError(
            response,
            { error: { message: rawText || `HTTP error ${response.status}: ${response.statusText}` } },
            type, opts, config, attempt, maxAttempts,
          )
        }
      }

      // If server didn't return SSE, fallback to non-stream handling
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        try {
          const json = await response.json() as any
          if (json && typeof json === 'object' && 'error' in json) {
            return handleApiError(response, json, type, opts, config, attempt, maxAttempts)
          }
          const asCompletion = json as OpenAI.ChatCompletion
          return convertCompletionToStream(asCompletion)
        } catch (e) {
          const rawText = await response.text().catch(() => '')
          return handleApiError(
            response,
            { error: { message: rawText || 'Non-SSE response could not be parsed' } },
            type, opts, config, attempt, maxAttempts,
          )
        }
      }
      
      // Create a stream that checks for errors while still yielding chunks
      const stream = createStreamProcessor(response.body as any)
      return (async function* errorAwareStream() {
        let hasReportedError = false
        
        try {
          for await (const chunk of stream) {
            // Safely check for errors
            if (chunk && typeof chunk === 'object') {
              const chunkObj = chunk as any
              if (chunkObj.error) {
                if (!hasReportedError) {
                  hasReportedError = true
                  const errorValue = chunkObj.error
                  
                  // Log error
                  logEvent('stream_error', {
                    error: typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue)
                  })
                  
                  // Handle the error - this will return a new completion or stream
                  const errorResult = await handleApiError(response, errorValue, type, opts, config, attempt, maxAttempts)
                  
                  // If it's a stream, yield from it and return
                  if (Symbol.asyncIterator in errorResult) {
                    for await (const errorChunk of errorResult as AsyncIterable<OpenAI.ChatCompletionChunk>) {
                      yield errorChunk
                    }
                    return // End this generator after yielding all chunks from error result
                  } else {
                    // It's a regular completion, not a stream. Convert it into a synthetic stream
                    // so the rest of the pipeline can continue consuming chunks.
                    const synthetic = convertCompletionToStream(errorResult as OpenAI.ChatCompletion)
                    for await (const errorChunk of synthetic) {
                      yield errorChunk
                    }
                    return
                  }
                }
                
                // Skip yielding this error chunk
                continue
              }
            }
            
            // Only yield good chunks
            yield chunk
          }
        } catch (e) {
          const msg = (e as any)?.message || String(e)
          console.error('Error in stream processing:', msg)
          // Attempt graceful fallback: retry without streaming
          try {
            const nonStreamOpts = { ...opts }
            delete (nonStreamOpts as any).stream_options
            ;(nonStreamOpts as any).stream = false
            const fallback = await getCompletion(type, nonStreamOpts, attempt + 1, maxAttempts)
            if (Symbol.asyncIterator in (fallback as any)) {
              for await (const errorChunk of (fallback as AsyncIterable<OpenAI.ChatCompletionChunk>)) {
                yield errorChunk
              }
              return
            } else {
              const synthetic = convertCompletionToStream(fallback as OpenAI.ChatCompletion)
              for await (const errorChunk of synthetic) {
                yield errorChunk
              }
              return
            }
          } catch (fallbackErr) {
            // If fallback also fails, propagate original error
            throw e
          }
        }
      })()
    }
    
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts),
      dispatcher: proxy,
    })

    logEvent('response.ok', {
      ok: String(response.ok),
      status: String(response.status),
      statusText: response.statusText,
    })
    
    if (!response.ok) {
      const rawText = await response.text().catch(() => '')
      try {
        const parsed = rawText ? JSON.parse(rawText) : undefined
        const error = (parsed ?? { error: { message: rawText || `HTTP error ${response.status}: ${response.statusText}` } }) as { error?: { message: string }, message?: string }
        return handleApiError(response, error, type, opts, config, attempt, maxAttempts)
      } catch {
        return handleApiError(
          response, 
          { error: { message: rawText || `HTTP error ${response.status}: ${response.statusText}` }}, 
          type, opts, config, attempt, maxAttempts
        )
      }
    }

    // Get the raw response data and check for errors even in OK responses
    const responseData = await response.json() as OpenAI.ChatCompletion
    
    // Check for error property in the successful response
    if (responseData && typeof responseData === 'object' && 'error' in responseData) {
      const errorValue = (responseData as any).error
      
      // Log the error
      logEvent('completion_error', {
        error: typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue)
      })
      
      // Handle the error
      return handleApiError(response, { error: errorValue }, type, opts, config, attempt, maxAttempts)
    }
    
    // Return non-stream completion as-is (consumers expect an object when stream=false)
    return responseData
  } catch (error) {
    // Handle network errors or other exceptions
    if (attempt < maxAttempts - 1) {
      const delay = Math.pow(2, attempt) * 1000
      await new Promise(resolve => setTimeout(resolve, delay))
      return getCompletion(type, opts, attempt + 1, maxAttempts)
    }
    throw new Error(`Network error: ${error.message || 'Unknown error'}`)
  } 
}

export function createStreamProcessor(
  stream: any
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  if (!stream) {
    throw new Error("Stream is null or undefined")
  }
  
  return (async function* () {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    
    try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (e) {
          console.error('Error reading from stream:', e);
          break;
        }
        
        const { done, value } = readResult;
        if (done) {
          break
        }
        
        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk
        
        let lineEnd = buffer.indexOf('\n')
        while (lineEnd !== -1) {
          const line = buffer.substring(0, lineEnd).trim()
          buffer = buffer.substring(lineEnd + 1)

          if (line === 'data: [DONE]') {
            continue
          }
          
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (!data) continue
            
            try {
              const parsed = JSON.parse(data) as OpenAI.ChatCompletionChunk
              yield parsed
            } catch (e) {
              console.error('Error parsing JSON:', data, e)
            }
          }
          
          lineEnd = buffer.indexOf('\n')
        }
      }
      
      // Process any remaining data in the buffer
      if (buffer.trim()) {
        const lines = buffer.trim().split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            const data = line.slice(6).trim()
            if (!data) continue
            
            try {
              const parsed = JSON.parse(data) as OpenAI.ChatCompletionChunk
              yield parsed
            } catch (e) {
              console.error('Error parsing final JSON:', data, e)
            }
          }
        }
      }
    } catch (e) {
      console.error('Unexpected error in stream processing:', e);
    } finally {
      try {
        reader.releaseLock()
      } catch (e) {
        console.error('Error releasing reader lock:', e);
      }
    }
  })()
}

export function streamCompletion(
  stream: any
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  return createStreamProcessor(stream)
}