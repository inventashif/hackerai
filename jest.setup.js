// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "util";
import { ReadableStream, TransformStream } from "stream/web";

// Mock environment variables
process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";

// Polyfill TextEncoder/TextDecoder for gpt-tokenizer
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Polyfill Web Streams API for AI SDK
global.ReadableStream = ReadableStream;
global.TransformStream = TransformStream;

// Default `fetch` for jsdom, which does not provide one. Components that fetch
// on mount (e.g. ModelSelector's Zen/Kiro catalogs) would otherwise throw
// "fetch is not defined" during render.
//
// Assigned only when absent, and deliberately without a `beforeEach` reset, so
// the many suites that install their own `global.fetch` keep full control.
// `jest.clearAllMocks()` below clears calls but preserves this implementation.
if (typeof global.fetch === "undefined") {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({}),
    text: async () => "",
  }));
}

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // Deprecated
    removeListener: jest.fn(), // Deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Global test utilities
global.beforeEach(() => {
  // Clear mocks before each test
  jest.clearAllMocks();
});
