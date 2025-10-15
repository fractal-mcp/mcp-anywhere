// Polyfill Web Crypto API for Jest test environment
// Jest's test environment doesn't expose globalThis.crypto even in Node 18+
// This ensures globalThis.crypto is available in tests while maintaining browser compatibility
const { webcrypto } = require('node:crypto');

if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = webcrypto;
}

