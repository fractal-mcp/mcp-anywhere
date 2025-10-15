import { ReadBuffer, serializeMessage } from '../shared/stdio.js';
import { JSONRPCMessage } from '../types.js';
import { Transport } from '../shared/transport.js';

// Check if we're in a Node.js environment
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

// Node.js stream types
interface NodeReadable {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    off(event: 'data', listener: (chunk: Buffer) => void): void;
    off(event: 'error', listener: (error: Error) => void): void;
    listenerCount(event: string): number;
    pause(): void;
}

interface NodeWritable {
    write(chunk: string): boolean;
    once(event: 'drain', listener: () => void): void;
}

/**
 * Server transport for stdio: this communicates with a MCP client by reading from the current process' stdin and writing to stdout.
 *
 * This transport is only available in Node.js environments.
 * In browser/edge environments, attempting to use this will throw an error.
 */
export class StdioServerTransport implements Transport {
    private _readBuffer: ReadBuffer = new ReadBuffer();
    private _started = false;
    private _stdin: NodeReadable;
    private _stdout: NodeWritable;

    constructor(stdin?: NodeReadable, stdout?: NodeWritable) {
        if (!isNode) {
            throw new Error(
                'StdioServerTransport is only available in Node.js environments. Use SSEServerTransport or StreamableHTTPServerTransport for browsers and edge runtimes.'
            );
        }

        // In Node.js, process is available globally
        this._stdin = stdin ?? ((globalThis as unknown as { process: { stdin: NodeReadable } }).process.stdin as NodeReadable);
        this._stdout = stdout ?? ((globalThis as unknown as { process: { stdout: NodeWritable } }).process.stdout as NodeWritable);
    }

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    // Arrow functions to bind `this` properly, while maintaining function identity.
    _ondata = (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
    };
    _onerror = (error: Error) => {
        this.onerror?.(error);
    };

    /**
     * Starts listening for messages on stdin.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;
        this._stdin.on('data', this._ondata);
        this._stdin.on('error', this._onerror);
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    async close(): Promise<void> {
        // Remove our event listeners first
        this._stdin.off('data', this._ondata);
        this._stdin.off('error', this._onerror);

        // Check if we were the only data listener
        const remainingDataListeners = this._stdin.listenerCount('data');
        if (remainingDataListeners === 0) {
            // Only pause stdin if we were the only listener
            // This prevents interfering with other parts of the application that might be using stdin
            this._stdin.pause();
        }

        // Clear the buffer and notify closure
        this._readBuffer.clear();
        this.onclose?.();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return new Promise(resolve => {
            const json = serializeMessage(message);
            if (this._stdout.write(json)) {
                resolve();
            } else {
                this._stdout.once('drain', resolve);
            }
        });
    }
}
