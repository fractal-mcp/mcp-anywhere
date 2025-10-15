import type { EventSourceMessage } from 'eventsource-parser';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { Transport, FetchLike } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';
import { auth, AuthResult, extractResourceMetadataUrl, OAuthClientProvider, UnauthorizedError } from './auth.js';

type SSEEventSourceInit = EventSourceInit & {
    fetch?: FetchLike;
    headers?: HeadersInit;
};

export class SseError extends Error {
    constructor(
        public readonly code: number | undefined,
        message: string | undefined,
        public readonly event?: unknown
    ) {
        super(`SSE error: ${message}`);
    }
}

/**
 * Configuration options for the `SSEClientTransport`.
 */
export type SSEClientTransportOptions = {
    /**
     * An OAuth client provider to use for authentication.
     *
     * When an `authProvider` is specified and the SSE connection is started:
     * 1. The connection is attempted with any existing access token from the `authProvider`.
     * 2. If the access token has expired, the `authProvider` is used to refresh the token.
     * 3. If token refresh fails or no access token exists, and auth is required, `OAuthClientProvider.redirectToAuthorization` is called, and an `UnauthorizedError` will be thrown from `connect`/`start`.
     *
     * After the user has finished authorizing via their user agent, and is redirected back to the MCP client application, call `SSEClientTransport.finishAuth` with the authorization code before retrying the connection.
     *
     * If an `authProvider` is not provided, and auth is required, an `UnauthorizedError` will be thrown.
     *
     * `UnauthorizedError` might also be thrown when sending any message over the SSE transport, indicating that the session has expired, and needs to be re-authed and reconnected.
     */
    authProvider?: OAuthClientProvider;

    /**
     * Customizes the initial SSE request to the server (the request that begins the stream).
     *
     * NOTE: Setting this property will prevent an `Authorization` header from
     * being automatically attached to the SSE request, if an `authProvider` is
     * also given. This can be worked around by setting the `Authorization` header
     * manually.
     */
    eventSourceInit?: SSEEventSourceInit;

    /**
     * Customizes recurring POST requests to the server.
     */
    requestInit?: RequestInit;

    /**
     * Custom fetch implementation used for all network requests.
     */
    fetch?: FetchLike;
};

/**
 * Client transport for SSE: this will connect to a server using Server-Sent Events for receiving
 * messages and make separate POST requests for sending messages.
 */
export class SSEClientTransport implements Transport {
    private _endpoint?: URL;
    private _abortController?: AbortController;
    private _reader?: ReadableStreamDefaultReader<EventSourceMessage>;
    private _url: URL;
    private _resourceMetadataUrl?: URL;
    private _eventSourceInit?: SSEEventSourceInit;
    private _requestInit?: RequestInit;
    private _authProvider?: OAuthClientProvider;
    private _fetch?: FetchLike;
    private _protocolVersion?: string;
    private _didEmitClose = false;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(url: URL, opts?: SSEClientTransportOptions) {
        this._url = url;
        this._resourceMetadataUrl = undefined;
        this._eventSourceInit = opts?.eventSourceInit;
        this._requestInit = opts?.requestInit;
        this._authProvider = opts?.authProvider;
        this._fetch = opts?.fetch;
    }

    private async _authThenStart(): Promise<void> {
        if (!this._authProvider) {
            throw new UnauthorizedError('No auth provider');
        }

        let result: AuthResult;
        try {
            result = await auth(this._authProvider, {
                serverUrl: this._url,
                resourceMetadataUrl: this._resourceMetadataUrl,
                fetchFn: this._fetch
            });
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }

        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError();
        }

        return await this._startOrAuth();
    }

    private async _commonHeaders(): Promise<Headers> {
        const headers: HeadersInit = {};
        if (this._authProvider) {
            const tokens = await this._authProvider.tokens();
            if (tokens) {
                headers['Authorization'] = `Bearer ${tokens.access_token}`;
            }
        }
        if (this._protocolVersion) {
            headers['mcp-protocol-version'] = this._protocolVersion;
        }

        return new Headers({ ...headers, ...this._requestInit?.headers });
    }

    private _mergeHeaders(target: Headers, headers?: HeadersInit): void {
        if (!headers) {
            return;
        }

        const source = new Headers(headers);
        source.forEach((value, key) => {
            target.set(key, value);
        });
    }

    private _emitClose(): void {
        if (this._didEmitClose) {
            return;
        }
        this._didEmitClose = true;
        this.onclose?.();
    }

    private async _startStream(fetchImpl: typeof fetch): Promise<void> {
        this._didEmitClose = false;
        this._endpoint = undefined;

        const controller = new AbortController();
        this._abortController = controller;
        const abortSignal = controller.signal;

        const headers = await this._commonHeaders();
        this._mergeHeaders(headers, this._eventSourceInit?.headers);
        headers.set('Accept', 'text/event-stream');

        const requestInit: RequestInit = {
            method: 'GET',
            headers,
            signal: abortSignal
        };

        if (this._eventSourceInit?.withCredentials === true) {
            requestInit.credentials = 'include';
        } else if (this._eventSourceInit?.withCredentials === false) {
            requestInit.credentials = 'omit';
        }

        let response: Response;
        try {
            response = await fetchImpl(this._url, requestInit);
        } catch (error) {
            controller.abort();
            this._abortController = undefined;
            this.onerror?.(error as Error);
            throw error;
        }

        if (response.status === 401 && response.headers.has('www-authenticate')) {
            this._resourceMetadataUrl = extractResourceMetadataUrl(response);
        }

        if (response.status === 401) {
            await response.body?.cancel?.().catch(() => {});
            this._abortController = undefined;

            if (this._authProvider) {
                return await this._authThenStart();
            }

            const error = new UnauthorizedError();
            this.onerror?.(error);
            throw error;
        }

        if (!response.ok) {
            const message = await response.text().catch(() => undefined);
            const error = new SseError(response.status, message, response);
            this._abortController = undefined;
            this.onerror?.(error);
            throw error;
        }

        if (!response.body) {
            const error = new Error('SSE response did not include a body');
            this._abortController = undefined;
            this.onerror?.(error);
            throw error;
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();

        this._reader = reader;

        return await new Promise((resolve, reject) => {
            let resolved = false;

            const resolveOnce = () => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            };

            const finish = (options: { error?: Error; aborted?: boolean } = {}) => {
                this._reader = undefined;
                this._abortController = undefined;

                if (!resolved) {
                    if (options.error) {
                        reject(options.error);
                    } else if (options.aborted) {
                        reject(new Error('SSE connection aborted'));
                    } else {
                        reject(new Error('SSE connection ended before receiving endpoint event'));
                    }
                } else if (options.error) {
                    this.onerror?.(options.error);
                } else {
                    this._emitClose();
                }
            };

            const process = async () => {
                try {
                    while (true) {
                        const { value, done } = await reader.read();

                        if (done) {
                            finish({ aborted: abortSignal.aborted });
                            return;
                        }

                        if (!value) {
                            continue;
                        }

                        const eventName = value.event ?? 'message';

                        if (eventName === 'endpoint') {
                            try {
                                this._endpoint = new URL(value.data, this._url);
                                if (this._endpoint.origin !== this._url.origin) {
                                    throw new Error(`Endpoint origin does not match connection origin: ${this._endpoint.origin}`);
                                }
                            } catch (error) {
                                finish({ error: error as Error });
                                return;
                            }

                            resolveOnce();
                            continue;
                        }

                        if (!resolved) {
                            continue;
                        }

                        try {
                            const message = JSONRPCMessageSchema.parse(JSON.parse(value.data));
                            this.onmessage?.(message);
                        } catch (error) {
                            this.onerror?.(error as Error);
                        }
                    }
                } catch (error) {
                    if ((error as DOMException).name === 'AbortError' || abortSignal.aborted) {
                        finish({ aborted: true });
                        return;
                    }
                    finish({ error: error as Error });
                }
            };

            void process();
        });
    }

    private _startOrAuth(): Promise<void> {
        const fetchImpl = (this?._eventSourceInit?.fetch ?? this._fetch ?? fetch) as typeof fetch;
        return this._startStream(fetchImpl);
    }

    async start(): Promise<void> {
        if (this._abortController || this._reader) {
            throw new Error('SSEClientTransport already started! If using Client class, note that connect() calls start() automatically.');
        }

        await this._startOrAuth();
    }

    /**
     * Call this method after the user has finished authorizing via their user agent and is redirected back to the MCP client application. This will exchange the authorization code for an access token, enabling the next connection attempt to successfully auth.
     */
    async finishAuth(authorizationCode: string): Promise<void> {
        if (!this._authProvider) {
            throw new UnauthorizedError('No auth provider');
        }

        const result = await auth(this._authProvider, {
            serverUrl: this._url,
            authorizationCode,
            resourceMetadataUrl: this._resourceMetadataUrl,
            fetchFn: this._fetch
        });
        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError('Failed to authorize');
        }
    }

    async close(): Promise<void> {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = undefined;
        }

        if (this._reader) {
            try {
                await this._reader.cancel();
            } catch {
                // Ignore cancellation errors.
            }
            this._reader = undefined;
        }

        this._emitClose();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._endpoint) {
            throw new Error('Not connected');
        }

        try {
            const headers = await this._commonHeaders();
            headers.set('content-type', 'application/json');
            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: this._abortController?.signal
            };

            const fetchImpl = (this._fetch ?? fetch) as typeof fetch;
            const response = await fetchImpl(this._endpoint, init);
            if (!response.ok) {
                if (response.status === 401 && this._authProvider) {
                    this._resourceMetadataUrl = extractResourceMetadataUrl(response);

                    const result = await auth(this._authProvider, {
                        serverUrl: this._url,
                        resourceMetadataUrl: this._resourceMetadataUrl,
                        fetchFn: this._fetch
                    });
                    if (result !== 'AUTHORIZED') {
                        throw new UnauthorizedError();
                    }

                    return this.send(message);
                }

                const text = await response.text().catch(() => null);
                throw new Error(`Error POSTing to endpoint (HTTP ${response.status}): ${text}`);
            }
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }
}
