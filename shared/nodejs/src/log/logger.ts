/**
 * Custom logger implementation for SuperTokens
 * Provides debug functionality with colors, namespaces, and environment controls
 */

import util from "util";
import setup from "./common";

interface LoggerConfig {
  colors: number[];
  useColors: () => boolean;
  formatArgs: (args: any[]) => void;
  log: (...args: any[]) => void;
  save: (namespaces: string) => void;
  load: () => string | undefined;
  humanize: (ms: number) => string;
}

/**
 * Available colors for different namespaces
 */
const BASIC_COLORS = [6, 2, 3, 4, 5, 1];

const EXTENDED_COLORS = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62, 63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92,
  93, 98, 99, 112, 113, 128, 129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172,
  173, 178, 179, 184, 185, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
];

/**
 * Check if extended colors are supported
 */
function supportsExtendedColors(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const supportsColor = require("supports-color");
    return supportsColor && (supportsColor.stderr || supportsColor).level >= 2;
  } catch {
    return false;
  }
}

/**
 * Determine if colors should be used in output
 */
function shouldUseColors(): boolean {
  return false;
}

/**
 * Format arguments for colored output
 */
function formatArgs(this: any, args: any[]): void {
  const { namespace, useColors, color } = this;

  if (useColors) {
    const colorCode = color < 8 ? `3${color}` : `38;5;${color}`;
    const prefix = `\u001B[${colorCode};1m${namespace}\u001B[0m`;

    args[0] = `${prefix} ${args[0]}`.split("\n").join(`\n${prefix} `);
    args.push(`\u001B[${colorCode}m+${humanizeTime(this.diff)}\u001B[0m`);
  } else {
    const timestamp = new Date().toISOString();
    args[0] = `${timestamp} ${namespace} ${args[0]}`;
  }
}

/**
 * Write formatted output to stderr
 */
function writeOutput(...args: any[]): void {
  process.stderr.write(util.format(...args) + "\n");
}

/**
 * Save debug configuration to environment
 */
function saveConfig(namespaces: string): void {
  if (namespaces) {
    process.env.DEBUG = namespaces;
  } else {
    delete process.env.DEBUG;
  }
}

/**
 * Load debug configuration from environment
 */
function loadConfig(): string | undefined {
  return process.env.DEBUG;
}

/**
 * Simple time humanization (replaces ms dependency)
 */
function humanizeTime(milliseconds: number): string {
  if (milliseconds >= 1000) {
    const seconds = Math.round(milliseconds / 1000);
    return `${seconds}s`;
  }
  return `${milliseconds}ms`;
}

/**
 * Create the logger configuration
 */
function createLoggerConfig(): LoggerConfig {
  const colors = supportsExtendedColors() ? EXTENDED_COLORS : BASIC_COLORS;

  return {
    colors,
    useColors: shouldUseColors,
    formatArgs,
    log: writeOutput,
    save: saveConfig,
    load: loadConfig,
    humanize: humanizeTime,
  };
}

// Initialize the logger using the common setup
const config = createLoggerConfig();
const logger = setup(config);

// Add custom formatters for object inspection
if (logger.formatters) {
  logger.formatters.o = function (this: any, value: any) {
    return util
      .inspect(value, { colors: this.useColors, compact: true })
      .split("\n")
      .map((line: string) => line.trim())
      .join(" ");
  };

  logger.formatters.O = function (this: any, value: any) {
    return util.inspect(value, { colors: this.useColors, compact: false });
  };
}

export default logger;
