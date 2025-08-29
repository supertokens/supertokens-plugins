import "@testing-library/jest-dom";
import { vi } from "vitest";

global.fetch = vi.fn();

// Mock window.location
Object.defineProperty(window, "location", {
  writable: true,
  value: {
    href: "https://example.com",
    hostname: "example.com",
    search: "",
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  },
});

// Mock URL constructor for tests
global.URL = class URL {
  href: string;
  hostname: string;
  searchParams: URLSearchParams;

  constructor(url: string) {
    this.href = url;
    this.hostname = url.includes("://") ? url.split("://")[1].split("/")[0] : url.split("/")[0];
    const searchStart = url.indexOf("?");
    this.searchParams = new URLSearchParams(searchStart !== -1 ? url.substring(searchStart) : "");
  }

  toString() {
    return this.href + (this.searchParams.toString() ? "?" + this.searchParams.toString() : "");
  }
} as any;

afterEach(() => {
  vi.clearAllMocks();
  // Reset window.location.href
  window.location.href = "https://example.com";
  window.location.hostname = "example.com";
  window.location.search = "";
});