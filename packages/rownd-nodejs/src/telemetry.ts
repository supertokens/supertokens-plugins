import { Axiom } from "@axiomhq/js";
import { PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";

export class TelemetryService {
  private client: Axiom | undefined;
  private dataset: string | undefined;

  constructor(config?: { token: string; dataset: string }) {
    if (config?.token && config?.dataset) {
      this.client = new Axiom({
        token: config.token,
      });
      this.dataset = config.dataset;
    }
  }

  async log(event: Record<string, unknown>) {
    if (!this.client || !this.dataset) return;

    try {
      await this.client.ingest(this.dataset, {
        ...event,
        plugin: PLUGIN_ID,
        version: PLUGIN_SDK_VERSION,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Silently fail telemetry
    }
  }

  async logError(
    operation: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) {
    await this.log({
      type: "error",
      operation,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...context,
    });
  }

  async logSuccess(operation: string, context?: Record<string, unknown>) {
    await this.log({
      type: "success",
      operation,
      ...context,
    });
  }
}
