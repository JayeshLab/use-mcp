import {
  CallToolResultSchema,
  JSONRPCMessage,
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
} from '@modelcontextprotocol/sdk/types.js'
import { ref, onMounted, onUnmounted, watch, readonly } from 'vue'
// Import both transport types
import { SSEClientTransport, SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js' // Added
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { sanitizeUrl } from 'strict-url-sanitise'
import { BrowserOAuthClientProvider } from '../auth/browser-provider.js' // Adjust path
import { assert } from '../utils/assert.js' // Adjust path
import type { UseMcpOptions, UseMcpResult } from './types.js' // Adjust path
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js' // Added for type safety

const DEFAULT_RECONNECT_DELAY = 3000
const DEFAULT_RETRY_DELAY = 5000
const AUTH_TIMEOUT = 5 * 60 * 1000

// Define Transport types literal for clarity
type TransportType = 'http' | 'sse'

export function useMcp(options: UseMcpOptions): UseMcpResult {
  const {
    url,
    clientName,
    clientUri,
    callbackUrl = typeof window !== 'undefined'
      ? sanitizeUrl(new URL('/oauth/callback', window.location.origin).toString())
      : '/oauth/callback',
    storageKeyPrefix = 'mcp:auth',
    clientConfig = {},
    customHeaders = {},
    debug = false,
    autoRetry = false,
    autoReconnect = DEFAULT_RECONNECT_DELAY,
    transportType = 'auto',
    preventAutoAuth = false,
    onPopupWindow,
  } = options

  const state = ref<UseMcpResult['state']['value']>('discovering')
  const tools = ref<Tool[]>([])
  const resources = ref<Resource[]>([])
  const resourceTemplates = ref<ResourceTemplate[]>([])
  const prompts = ref<Prompt[]>([])
  const error = ref<string | undefined>(undefined)
  const log = ref<UseMcpResult['log']['value']>([])
  const authUrl = ref<string | undefined>(undefined)

  const clientRef = ref<Client | null>(null)
  // Transport ref can hold either type now
  const transportRef = ref<Transport | null>(null)
  const authProviderRef = ref<BrowserOAuthClientProvider | null>(null)
  const connectingRef = ref<boolean>(false)
  const connectAttemptRef = ref<number>(0)
  const authTimeoutRef = ref<number | null>(null)

  // Ref to store the type of transport that successfully connected
  const successfulTransportRef = ref<TransportType | null>(null)

  // --- Stable Callbacks ---
  const addLog = (level: UseMcpResult['log']['value'][0]['level'], message: string, ...args: unknown[]) => {
    // if (level === 'debug' && !debug) return; // Uncomment if using debug flag
    const fullMessage = args.length > 0 ? `${message} ${args.map((arg) => JSON.stringify(arg)).join(' ')}` : message
    console[level](`[useMcp] ${fullMessage}`)
    log.value = [...log.value.slice(-100), { level, message: fullMessage, timestamp: Date.now() }]
  }

  const disconnect = async (quiet = false) => {
    if (!quiet) addLog('info', 'Disconnecting...')
    connectingRef.value = false
    if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
    authTimeoutRef.value = null

    const transport = transportRef.value
    clientRef.value = null // Ensure client is cleared
    transportRef.value = null // Ensure transport is cleared

    // Only reset state if not a quiet disconnect
    if (!quiet) {
      state.value = 'discovering'
      tools.value = []
      resources.value = []
      resourceTemplates.value = []
      prompts.value = []
      error.value = undefined
      authUrl.value = undefined
    }

    if (transport) {
      try {
        await transport.close()
        if (!quiet) addLog('debug', 'Transport closed')
      } catch (err) {
        if (!quiet) addLog('warn', 'Error closing transport:', err)
      }
    }
  }

  const failConnection = (errorMessage: string, connectionError?: Error) => {
    addLog('error', errorMessage, connectionError ?? '')
    state.value = 'failed' // Set state to failed
    error.value = errorMessage
    const manualUrl = authProviderRef.value?.getLastAttemptedAuthUrl()
    if (manualUrl) {
      authUrl.value = manualUrl
      addLog('info', 'Manual authentication URL may be available.', manualUrl)
    }
    connectingRef.value = false // Ensure connection attempt is marked as finished
  }

  const connect = async () => {
    // Prevent concurrent connections
    if (connectingRef.value) {
      addLog('debug', 'Connection attempt already in progress.')
      return
    }

    connectingRef.value = true // Mark start of connection sequence
    connectAttemptRef.value += 1
    error.value = undefined
    authUrl.value = undefined
    successfulTransportRef.value = null // Reset successful transport type
    state.value = 'discovering'
    addLog('info', `Connecting attempt #${connectAttemptRef.value} to ${url}...`)

    // Initialize provider/client if needed (idempotent)
    // Ensure provider/client are initialized (idempotent check)
    if (!authProviderRef.value) {
      authProviderRef.value = new BrowserOAuthClientProvider(url, {
        storageKeyPrefix,
        clientName,
        clientUri,
        callbackUrl,
        preventAutoAuth,
        onPopupWindow,
      })
      addLog('debug', 'BrowserOAuthClientProvider initialized in connect.')
    }
    if (!clientRef.value) {
      clientRef.value = new Client(
        { name: clientConfig.name || 'use-mcp-vue-client', version: clientConfig.version || '0.1.0' },
        { capabilities: {} },
      )
      addLog('debug', 'MCP Client initialized in connect.')
    }

    // --- Helper function for a single connection attempt ---
    const tryConnectWithTransport = async (transportType: TransportType): Promise<'success' | 'fallback' | 'auth_redirect' | 'failed'> => {
      addLog('info', `Attempting connection with ${transportType.toUpperCase()} transport...`)
      // Ensure state reflects current attempt phase, unless already authenticating
      if (state.value !== 'authenticating') {
        state.value = 'connecting'
      }

      let transportInstance: Transport // Use base Transport type

      // 1. Create Transport Instance & Close Previous
      try {
        assert(authProviderRef.value, 'Auth Provider must be initialized')
        assert(clientRef.value, 'Client must be initialized')

        // Close existing transport before creating new one
        if (transportRef.value) {
          await transportRef.value.close().catch((e) => addLog('warn', `Error closing previous transport: ${e.message}`))
          transportRef.value = null
        }

        const commonOptions: SSEClientTransportOptions = {
          authProvider: authProviderRef.value,
          requestInit: {
            headers: {
              Accept: 'application/json, text/event-stream',
              ...customHeaders,
            },
          },
        }
        // Sanitize the URL to prevent XSS attacks from malicious server URLs
        const sanitizedUrl = sanitizeUrl(url)
        const targetUrl = new URL(sanitizedUrl)

        addLog('debug', `Creating ${transportType.toUpperCase()} transport for URL: ${targetUrl.toString()}`)
        addLog('debug', `Transport options:`, {
          authProvider: !!authProviderRef.value,
          headers: customHeaders,
          url: targetUrl.toString(),
        })

        if (transportType === 'http') {
          addLog('debug', 'Creating StreamableHTTPClientTransport...')
          transportInstance = new StreamableHTTPClientTransport(targetUrl, commonOptions)
          addLog('debug', 'StreamableHTTPClientTransport created successfully')
        } else {
          // sse
          addLog('debug', 'Creating SSEClientTransport...')
          transportInstance = new SSEClientTransport(targetUrl, commonOptions)
          addLog('debug', 'SSEClientTransport created successfully')
        }
        transportRef.value = transportInstance // Assign to ref immediately
        addLog('debug', `${transportType.toUpperCase()} transport created and assigned to ref.`)
      } catch (err) {
        failConnection(
          `Failed to create ${transportType.toUpperCase()} transport: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined,
        )
        return 'failed' // Indicate definitive failure
      }

      // 2. Setup Handlers for the new transportInstance
      transportInstance.onmessage = (message: JSONRPCMessage) => {
        addLog('debug', `[Transport] Received: ${JSON.stringify(message)}`)
        // @ts-ignore
        clientRef.value?.handleMessage?.(message) // Forward to current client
      }
      transportInstance.onerror = (err: Error) => {
        // Transport errors usually mean connection is lost/failed definitively for this transport
        addLog('warn', `Transport error event (${transportType.toUpperCase()}):`, err)
        addLog('debug', `Error details:`, {
          message: err.message,
          stack: err.stack,
          name: err.name,
          cause: err.cause,
        })
        failConnection(`Transport error (${transportType.toUpperCase()}): ${err.message}`, err)
      }
      transportInstance.onclose = () => {
        if (connectingRef.value) return // Ignore if connecting/unmounted

        addLog('info', `Transport connection closed (${successfulTransportRef.value || 'unknown'} type).`)

        if (state.value === 'ready' && autoReconnect) {
          const delay = typeof autoReconnect === 'number' ? autoReconnect : DEFAULT_RECONNECT_DELAY
          addLog('info', `Attempting to reconnect in ${delay}ms...`)
          state.value = 'connecting'
          setTimeout(() => {
            connect() // Start full connect logic again (will default to HTTP)
          }, delay)
        } else if (state.value !== 'failed' && state.value !== 'authenticating') {
          failConnection('Connection closed unexpectedly.')
        }
      }

      // 3. Attempt client.connect()
      try {
        addLog('info', `Connecting client via ${transportType.toUpperCase()}...`)
        addLog('debug', `About to call client.connect() with transport instance`)
        addLog('debug', `Transport instance type: ${transportInstance.constructor.name}`)

        await clientRef.value!.connect(transportInstance)

        // --- Success Path ---
        addLog('info', `Client connected via ${transportType.toUpperCase()}. Loading tools, resources, and prompts...`)
        successfulTransportRef.value = transportType // Store successful type
        state.value = 'loading'

        const toolsResponse = await clientRef.value!.request({ method: 'tools/list' }, ListToolsResultSchema)

        // Load resources after tools (optional - not all servers support resources)
        let resourcesResponse: { resources: Resource[]; resourceTemplates?: ResourceTemplate[] } = { resources: [], resourceTemplates: [] }
        try {
          resourcesResponse = await clientRef.value!.request({ method: 'resources/list' }, ListResourcesResultSchema)
        } catch (err) {
          addLog('debug', 'Server does not support resources/list method', err)
        }

        // Load prompts after resources (optional - not all servers support prompts)
        let promptsResponse: { prompts: Prompt[] } = { prompts: [] }
        try {
          promptsResponse = await clientRef.value!.request({ method: 'prompts/list' }, ListPromptsResultSchema)
        } catch (err) {
          addLog('debug', 'Server does not support prompts/list method', err)
        }

        tools.value = toolsResponse.tools
        resources.value = resourcesResponse.resources
        resourceTemplates.value = Array.isArray(resourcesResponse.resourceTemplates) ? resourcesResponse.resourceTemplates : []
        prompts.value = promptsResponse.prompts
        const summary = [`Loaded ${toolsResponse.tools.length} tools`]
        if (
          resourcesResponse.resources.length > 0 ||
          (resourcesResponse.resourceTemplates && resourcesResponse.resourceTemplates.length > 0)
        ) {
          summary.push(`${resourcesResponse.resources.length} resources`)
          if (Array.isArray(resourcesResponse.resourceTemplates) && resourcesResponse.resourceTemplates.length > 0) {
            summary.push(`${resourcesResponse.resourceTemplates.length} resource templates`)
          }
        }
        if (promptsResponse.prompts.length > 0) {
          summary.push(`${promptsResponse.prompts.length} prompts`)
        }

        addLog('info', summary.join(', ') + '.')
        state.value = 'ready' // Final success state
        // connectingRef will be set to false after orchestration logic
        connectAttemptRef.value = 0 // Reset on success
        return 'success'
      } catch (connectErr) {
        // --- Error Handling Path ---
        addLog('debug', `Client connect error via ${transportType.toUpperCase()}:`, connectErr)
        addLog('debug', `Connect error details:`, {
          message: connectErr instanceof Error ? connectErr.message : String(connectErr),
          stack: connectErr instanceof Error ? connectErr.stack : 'N/A',
          name: connectErr instanceof Error ? connectErr.name : 'Unknown',
          cause: connectErr instanceof Error ? connectErr.cause : undefined,
        })
        const errorInstance = connectErr instanceof Error ? connectErr : new Error(String(connectErr))

        // Check for 404/405 specifically for HTTP transport
        const errorMessage = errorInstance.message
        const is404 = errorMessage.includes('404') || errorMessage.includes('Not Found')
        const is405 = errorMessage.includes('405') || errorMessage.includes('Method Not Allowed')
        const isLikelyCors =
          errorMessage === 'Failed to fetch' /* Chrome */ ||
          errorMessage === 'NetworkError when attempting to fetch resource.' /* Firefox */ ||
          errorMessage === 'Load failed' /* Safari */

        if (transportType === 'http' && (is404 || is405 || isLikelyCors)) {
          addLog('warn', `HTTP transport failed (${isLikelyCors ? 'CORS' : is404 ? '404' : '405'}).`)
          return 'fallback' // Signal that fallback should be attempted
        }

        // Check for Auth error (Simplified - requires more thought for interaction with fallback)
        if (errorInstance instanceof UnauthorizedError || errorMessage.includes('Unauthorized') || errorMessage.includes('401')) {
          addLog('info', 'Authentication required.')

          // Check if we have existing tokens before triggering auth flow
          assert(authProviderRef.value, 'Auth Provider not available for auth flow')
          const existingTokens = await authProviderRef.value.tokens()

          // If preventAutoAuth is enabled and no valid tokens exist, go to pending_auth state
          if (preventAutoAuth && !existingTokens) {
            addLog('info', 'Authentication required but auto-auth prevented. User action needed.')
            state.value = 'pending_auth'
            // We'll set the auth URL when the user manually triggers auth
            return 'auth_redirect' // Signal that we need user action
          }

          // Ensure state is set only once if multiple attempts trigger auth
          const currentState = state.value as any
          if (currentState !== 'authenticating' && currentState !== 'pending_auth') {
            state.value = 'authenticating'
            if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
            authTimeoutRef.value = setTimeout(() => {
              /* ... timeout logic ... */
            }, AUTH_TIMEOUT)
          }

          try {
            const authResult = await auth(authProviderRef.value, { serverUrl: url })

            if (authResult === 'AUTHORIZED') {
              addLog('info', 'Authentication successful via existing token or refresh. Re-attempting connection...')
              if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
              // Re-trigger the *entire* connect sequence after successful auth
              // It will start with HTTP again.
              // We return 'failed' here to stop current sequence, connect() below will handle restart.
              // Set connectingRef false so outer connect call can proceed
              connectingRef.value = false
              connect() // Restart full connection sequence
              return 'failed' // Stop this attempt sequence, new one started
            } else if (authResult === 'REDIRECT') {
              addLog('info', 'Redirecting for authentication. Waiting for callback...')
              return 'auth_redirect' // Signal that we are waiting for redirect
            }
          } catch (sdkAuthError) {
            if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
            failConnection(
              `Failed to initiate authentication: ${sdkAuthError instanceof Error ? sdkAuthError.message : String(sdkAuthError)}`,
              sdkAuthError instanceof Error ? sdkAuthError : undefined,
            )
            return 'failed' // Auth initiation failed
          }
        }

        // Handle other connection errors
        // For HTTP transport, consider fallback only for specific error types
        // "Not connected" errors should still be treated as failures, not fallback triggers
        failConnection(`Failed to connect via ${transportType.toUpperCase()}: ${errorMessage}`, errorInstance)
        return 'failed'
      }
    } // End of tryConnectWithTransport helper

    // --- Orchestrate Connection Attempts ---
    let finalStatus: 'success' | 'auth_redirect' | 'failed' | 'fallback' = 'failed' // Default to failed

    console.log({ transportType })

    if (transportType === 'sse') {
      // SSE only - skip HTTP entirely
      addLog('debug', 'Using SSE-only transport mode')
      finalStatus = await tryConnectWithTransport('sse')
    } else if (transportType === 'http') {
      // HTTP only - no fallback
      addLog('debug', 'Using HTTP-only transport mode')
      finalStatus = await tryConnectWithTransport('http')
    } else {
      // Auto mode - try HTTP first, fallback to SSE
      addLog('debug', 'Using auto transport mode (HTTP with SSE fallback)')
      const httpResult = await tryConnectWithTransport('http')

      // Try SSE only if HTTP requested fallback and we haven't redirected for auth
      // Allow fallback even if state is 'failed' from a previous HTTP attempt in auto mode
      const currentState = state.value as any
      if (httpResult === 'fallback' && currentState !== 'authenticating') {
        addLog('info', 'HTTP failed, attempting SSE fallback...')
        const sseResult = await tryConnectWithTransport('sse')
        finalStatus = sseResult // Use SSE result as final status

        // If SSE also failed, we need to properly fail the connection since HTTP didn't call failConnection
        if (sseResult === 'failed') {
          // SSE failure already called failConnection, so we don't need to do anything else
        }
      } else {
        finalStatus = httpResult // Use HTTP result if no fallback was needed/possible
      }
    }

    // --- Finalize Connection State ---
    // Set connectingRef based on the final outcome.
    // It should be false if 'success' or 'failed'.
    // It should remain true if 'auth_redirect'.
    if (finalStatus === 'success' || finalStatus === 'failed') {
      connectingRef.value = false
    }
    // If finalStatus is 'auth_redirect', connectingRef remains true (set at the start).

    addLog('debug', `Connection sequence finished with status: ${finalStatus}`)
  }

  const callTool = async (name: string, args?: Record<string, unknown>) => {
    if (state.value !== 'ready' || !clientRef.value) {
      throw new Error(`MCP client is not ready (current state: ${state.value}). Cannot call tool "${name}".`)
    }
    addLog('info', `Calling tool: ${name}`, args)
    try {
      const result = await clientRef.value.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema)
      addLog('info', `Tool "${name}" call successful:`, result)
      return result
    } catch (err) {
      addLog('error', `Error calling tool "${name}": ${err instanceof Error ? err.message : String(err)}`, err)
      const errorInstance = err instanceof Error ? err : new Error(String(err))

      if (
        errorInstance instanceof UnauthorizedError ||
        errorInstance.message.includes('Unauthorized') ||
        errorInstance.message.includes('401')
      ) {
        addLog('warn', 'Tool call unauthorized, attempting re-authentication...')
        state.value = 'authenticating' // Update UI state
        if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value) // Reset timeout
        authTimeoutRef.value = setTimeout(() => {
          /* ... timeout logic ... */
        }, AUTH_TIMEOUT)

        try {
          assert(authProviderRef.value, 'Auth Provider not available for tool re-auth')
          const authResult = await auth(authProviderRef.value, { serverUrl: url })

          if (authResult === 'AUTHORIZED') {
            addLog('info', 'Re-authentication successful. Retrying tool call is recommended, or reconnecting.')
            if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
            connectingRef.value = false
            connect() // Reconnect session
          } else if (authResult === 'REDIRECT') {
            addLog('info', 'Redirecting for re-authentication for tool call.')
            // State is authenticating, wait for callback
          }
        } catch (sdkAuthError) {
          if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
          failConnection(
            `Re-authentication failed: ${sdkAuthError instanceof Error ? sdkAuthError.message : String(sdkAuthError)}`,
            sdkAuthError instanceof Error ? sdkAuthError : undefined,
          )
        }
      }
      // Re-throw original error unless handled by re-auth redirect
      if (state.value !== 'authenticating') {
        // Only re-throw if not waiting for redirect
        throw err
      }
      return undefined
    }
  }

  const retry = () => {
    if (state.value === 'failed') {
      addLog('info', 'Retry requested...')
      connect()
    } else {
      addLog('warn', `Retry called but state is not 'failed' (state: ${state.value}). Ignoring.`)
    }
  }

  const authenticate = async () => {
    addLog('info', 'Manual authentication requested...')

    if (state.value === 'failed') {
      addLog('info', 'Attempting to reconnect and authenticate via retry...')
      retry()
    } else if (state.value === 'pending_auth') {
      addLog('info', 'Proceeding with authentication from pending state...')
      state.value = 'authenticating'
      if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
      authTimeoutRef.value = setTimeout(() => {
        /* ... timeout logic ... */
      }, AUTH_TIMEOUT)

      try {
        assert(authProviderRef.value, 'Auth Provider not available for manual auth')
        const authResult = await auth(authProviderRef.value, { serverUrl: url })

        if (authResult === 'AUTHORIZED') {
          addLog('info', 'Manual authentication successful. Re-attempting connection...')
          if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
          connectingRef.value = false
          connect() // Restart full connection sequence
        } else if (authResult === 'REDIRECT') {
          addLog('info', 'Redirecting for manual authentication. Waiting for callback...')
          // State is already authenticating, wait for callback
        }
      } catch (authError) {
        if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
        failConnection(
          `Manual authentication failed: ${authError instanceof Error ? authError.message : String(authError)}`,
          authError instanceof Error ? authError : undefined,
        )
      }
    } else if (state.value === 'authenticating') {
      addLog('warn', 'Already attempting authentication. Check for blocked popups or wait for timeout.')
      const manualUrl = authProviderRef.value?.getLastAttemptedAuthUrl()
      if (manualUrl && !authUrl.value) {
        authUrl.value = manualUrl
        addLog('info', 'Manual authentication URL retrieved:', manualUrl)
      }
    } else {
      addLog(
        'info',
        `Client not in a state requiring manual authentication trigger (state: ${state.value}). If needed, try disconnecting and reconnecting.`,
      )
    }
  }

  const clearStorage = () => {
    if (authProviderRef.value) {
      const count = authProviderRef.value.clearStorage()
      addLog('info', `Cleared ${count} item(s) from localStorage for ${url}.`)
      authUrl.value = undefined // Clear manual URL state
      disconnect()
    } else {
      addLog('warn', 'Auth provider not initialized, cannot clear storage.')
    }
  }

  const listResources = async () => {
    if (state.value !== 'ready' || !clientRef.value) {
      throw new Error(`MCP client is not ready (current state: ${state.value}). Cannot list resources.`)
    }
    addLog('info', 'Listing resources...')
    try {
      const resourcesResponse = await clientRef.value.request({ method: 'resources/list' }, ListResourcesResultSchema)
      resources.value = resourcesResponse.resources
      resourceTemplates.value = Array.isArray(resourcesResponse.resourceTemplates) ? resourcesResponse.resourceTemplates : []
      addLog(
        'info',
        `Listed ${resourcesResponse.resources.length} resources, ${Array.isArray(resourcesResponse.resourceTemplates) ? resourcesResponse.resourceTemplates.length : 0} resource templates.`,
      )
    } catch (err) {
      addLog('error', `Error listing resources: ${err instanceof Error ? err.message : String(err)}`, err)
      throw err
    }
  }

  const readResource = async (uri: string) => {
    if (state.value !== 'ready' || !clientRef.value) {
      throw new Error(`MCP client is not ready (current state: ${state.value}). Cannot read resource "${uri}".`)
    }
    addLog('info', `Reading resource: ${uri}`)
    try {
      const result = await clientRef.value.request({ method: 'resources/read', params: { uri } }, ReadResourceResultSchema)
      addLog('info', `Resource "${uri}" read successfully`)
      return result
    } catch (err) {
      addLog('error', `Error reading resource "${uri}": ${err instanceof Error ? err.message : String(err)}`, err)
      throw err
    }
  }

  const listPrompts = async () => {
    if (state.value !== 'ready' || !clientRef.value) {
      throw new Error(`MCP client is not ready (current state: ${state.value}). Cannot list prompts.`)
    }
    addLog('info', 'Listing prompts...')
    try {
      const promptsResponse = await clientRef.value.request({ method: 'prompts/list' }, ListPromptsResultSchema)
      prompts.value = promptsResponse.prompts
      addLog('info', `Listed ${promptsResponse.prompts.length} prompts.`)
    } catch (err) {
      addLog('error', `Error listing prompts: ${err instanceof Error ? err.message : String(err)}`, err)
      throw err
    }
  }

  const getPrompt = async (name: string, args?: Record<string, string>) => {
    if (state.value !== 'ready' || !clientRef.value) {
      throw new Error(`MCP client is not ready (current state: ${state.value}). Cannot get prompt "${name}".`)
    }
    addLog('info', `Getting prompt: ${name}`, args)
    try {
      const result = await clientRef.value.request({ method: 'prompts/get', params: { name, arguments: args } }, GetPromptResultSchema)
      addLog('info', `Prompt "${name}" retrieved successfully`)
      return result
    } catch (err) {
      addLog('error', `Error getting prompt "${name}": ${err instanceof Error ? err.message : String(err)}`, err)
      throw err
    }
  }

  // ===== Effects =====
  let messageHandler: ((event: MessageEvent) => void) | null = null

  onMounted(() => {
    messageHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'mcp_auth_callback') {
        addLog('info', 'Received auth callback message.', event.data)
        if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)

        if (event.data.success) {
          addLog('info', 'Authentication successful via popup. Reconnecting client...')
          connectingRef.value = false
          connect()
        } else {
          failConnection(`Authentication failed in callback: ${event.data.error || 'Unknown reason.'}`)
        }
      }
    }
    window.addEventListener('message', messageHandler)
    addLog('debug', 'Auth callback message listener added.')

    // Initial Connection
    addLog('debug', 'useMcp mounted, initiating connection.')
    connectAttemptRef.value = 0
    if (!authProviderRef.value || authProviderRef.value.serverUrl !== url) {
      authProviderRef.value = new BrowserOAuthClientProvider(url, {
        storageKeyPrefix,
        clientName,
        clientUri,
        callbackUrl,
        preventAutoAuth,
        onPopupWindow,
      })
      addLog('debug', 'BrowserOAuthClientProvider initialized/updated on mount/option change.')
    }
    connect()
  })

  onUnmounted(() => {
    if (messageHandler) {
      window.removeEventListener('message', messageHandler)
      addLog('debug', 'Auth callback message listener removed.')
    }
    if (authTimeoutRef.value) clearTimeout(authTimeoutRef.value)
    addLog('debug', 'useMcp unmounting, disconnecting.')
    disconnect(true)
  })

  watch(state, (newState) => {
    if (newState === 'failed' && autoRetry && connectAttemptRef.value > 0) {
      const delay = typeof autoRetry === 'number' ? autoRetry : DEFAULT_RETRY_DELAY
      addLog('info', `Connection failed, auto-retrying in ${delay}ms...`)
      setTimeout(() => {
        if (state.value === 'failed') {
          retry()
        }
      }, delay)
    }
  })

  // --- Return Public API ---
  return {
    state,
    tools,
    resources,
    resourceTemplates,
    prompts,
    error,
    log,
    authUrl,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt,
    retry,
    disconnect,
    authenticate,
    clearStorage,
  }
}
