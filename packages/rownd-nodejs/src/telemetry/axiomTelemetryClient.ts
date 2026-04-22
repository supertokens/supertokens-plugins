import { PLUGIN_ID } from "../constants";
import { RowndTelemetryClient, RowndTelemetryEvent } from "../types";

const DEFAULT_AXIOM_URL = "https://api.axiom.co/v1/datasets";

export class AxiomTelemetryClient implements RowndTelemetryClient {
  private readonly url: string;

  constructor(
    private readonly token: string,
    private readonly dataset: string,
    endpoint?: string,
  ) {
    const baseUrl = (endpoint ?? DEFAULT_AXIOM_URL).replace(/\/$/, "");
    this.url = `${baseUrl}/${dataset}/ingest`;
  }

  async recordEvent(event: RowndTelemetryEvent): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          ts: new Date().toISOString(),
          plugin: PLUGIN_ID,
          ...event,
        },
      ]),
    });
  }
}
