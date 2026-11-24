import type { PluginRouteHandler } from "supertokens-node/types";

type Response = Parameters<PluginRouteHandler["handler"]>[1];

export function bufferSessionResponse(response: Response) {
  const writes: Array<() => void> = [];
  const buffered: Response = Object.create(response);
  buffered.setHeader = (...args) => { writes.push(() => response.setHeader(...args)); };
  buffered.removeHeader = (...args) => { writes.push(() => response.removeHeader(...args)); };
  buffered.setCookie = (...args) => { writes.push(() => response.setCookie(...args)); };
  return {
    response: buffered,
    flush: () => { for (const write of writes.splice(0)) write(); },
  };
}
