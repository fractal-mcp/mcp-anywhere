# mcp-anywhere

> Browser & edge compatible TypeScript SDK for Model Context Protocol

A fork of the [official Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) that works in Node.js, browsers, and edge runtimes.

## The Problem

The official [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) is an excellent implementation of the MCP specification, but it was designed primarily for Node.js environments. When attempting to use it in:

- **Browser environments** (via bundlers like Webpack, Vite, esbuild)
- **Cloudflare Workers** (V8 isolates with Web APIs)
- **Other edge runtimes** (Deno Deploy, Vercel Edge Functions, etc.)

...you'll encounter errors due to Node.js-specific dependencies like:

- `node:crypto` (randomUUID, randomBytes)
- `node:http` (IncomingMessage, ServerResponse)
- `node:stream` (for stdio)
- `node:child_process` (for spawning processes)
- Third-party Node modules (`raw-body`, `express`, etc.)

This fork solves these compatibility issues while maintaining **100% API compatibility** with the official SDK.

## The Solution

This fork systematically replaces Node.js-specific APIs with universal Web APIs, making the SDK work seamlessly in both Node.js and browser/edge environments.

### What Changed

#### Transport Modules

**`src/server/sse.ts`** and **`src/server/streamableHttp.ts`**

- Replaced `node:crypto` with `globalThis.crypto` (Web Crypto API)
- Replaced `node:http` types with generic `RequestLike`/`ResponseLike` interfaces
- Replaced `raw-body` with `request.text()` for Fetch API and fallback stream reading for Node.js
- Added `createSSESessionAdapter()` function to create Fetch-compatible SSE sessions for edge runtimes

**`src/server/stdio.ts`** and **`src/client/stdio.ts`**

- **Still Node.js-only** (by design - stdio is inherently Node-specific)
- Made safe to import: detects runtime and throws descriptive errors in non-Node environments
- Uses `globalThis.process` instead of direct imports
- Lazy-loads Node-specific modules (`cross-spawn`, `node:stream`)

#### Authentication Modules

**`src/server/auth/handlers/register.ts`**

- Replaced `crypto.randomBytes()` with Web Crypto API
- Lazy-loaded Express dependencies (`express`, `cors`, `express-rate-limit`) for better tree-shaking
- Added runtime environment detection

#### Utility Modules

**`src/shared/stdio.ts`** and related files

- Runtime-safe implementations that work in both Node.js and Web environments
- Proper type annotations for universal compatibility

### Key Features

**Universal Transports**

- **SSEServerTransport**: Works in Node.js, browsers, and edge runtimes
- **StreamableHTTPServerTransport**: Works in Node.js, browsers, and edge runtimes
- **StdioServerTransport**: Node.js only (safe to import, runtime-detected)

**Edge Runtime Support**

- Cloudflare Workers (V8 isolates)
- Deno Deploy
- Vercel Edge Functions
- Any environment with Web APIs

**100% API Compatible**

- Drop-in replacement for `@modelcontextprotocol/sdk`
- All official examples work unchanged
- Same imports, same API surface

## Installation

```bash
npm install mcp-anywhere
```

## Requirements

**Node.js 16.0.0+** (required for Web Crypto API)

- `globalThis.crypto.randomUUID()`
- `globalThis.crypto.getRandomValues()`

**Browsers**: Any modern browser with Web Crypto API support (all evergreen browsers)

**Edge Runtimes**: Cloudflare Workers, Deno Deploy, Vercel Edge Functions, etc.

## Usage

**Usage is exactly the same as the official SDK!** All examples from the [official documentation](https://github.com/modelcontextprotocol/typescript-sdk) work without modification.

### Important: Stdio Limitations

**StdioServerTransport and StdioClientTransport still require Node.js.** This is by design—stdio is fundamentally a Node.js concept (process.stdin/stdout, child processes).

```typescript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Works in Node.js
const transport = new StdioServerTransport();

// Throws clear error in browsers/edge runtimes:
// "StdioServerTransport is only available in Node.js environments.
//  Use SSEServerTransport or StreamableHTTPServerTransport for browsers and edge runtimes."
```

**For browsers and edge runtimes, use:**

- `SSEServerTransport` / `SSEClientTransport`
- `StreamableHTTPServerTransport` / `StreamableHTTPClientTransport`

## Testing

Tests use the same infrastructure as the official SDK:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- <test-file-pattern>

# Run with coverage
npm test -- --coverage
```

**Integration tests** verify that the refactored code works in both Node.js and simulated edge environments (using `wrangler dev` for Cloudflare Workers testing).

## Package Exports

This fork maintains the same conditional exports as the official SDK:

```json
{
    "exports": {
        "./server/*": {
            "types": "./dist/server/*.d.ts",
            "default": "./dist/server/*.js"
        },
        "./client/*": {
            "types": "./dist/client/*.d.ts",
            "default": "./dist/client/*.js"
        }
    }
}
```

Node-specific peer dependencies (`express`, `raw-body`, `cross-spawn`) are marked as **optional**, so they won't cause installation failures in browser/edge environments.

## Differences from Official SDK

| Aspect                       | Official SDK      | This Fork               |
| ---------------------------- | ----------------- | ----------------------- |
| **Node.js**                  | ✅ Full support   | ✅ Full support         |
| **Browsers**                 | ❌ Import errors  | ✅ Full support         |
| **Cloudflare Workers**       | ❌ Runtime errors | ✅ Full support         |
| **Edge Runtimes**            | ❌ Various issues | ✅ Full support         |
| **API Compatibility**        | -                 | ✅ 100% compatible      |
| **Stdio Transport**          | ✅ Works          | ✅ Works (Node.js only) |
| **SSE Transport**            | ✅ Works          | ✅ Works everywhere     |
| **StreamableHTTP Transport** | ✅ Works          | ✅ Works everywhere     |

## Documentation

For full MCP protocol documentation and usage examples, see:

- [Official MCP Documentation](https://modelcontextprotocol.io)
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io)

This fork implements the same APIs, so all official examples and documentation apply.

## Contributing

Issues and pull requests are welcome! Since this is a compatibility fork, contributions should:

1. Maintain 100% API compatibility with the official SDK
2. Use Web APIs instead of Node.js-specific APIs where possible
3. Include tests for both Node.js and edge runtime environments
4. Document any platform-specific behavior

## License

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.

---

**Upstream:** [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
