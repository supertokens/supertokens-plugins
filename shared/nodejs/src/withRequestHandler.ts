import { JSONObject, PluginRouteHandler } from 'supertokens-node/types';

export const withRequestHandler = (
  fn: (
    ...params: Parameters<PluginRouteHandler['handler']>
  ) => Promise<({ status: 'OK' } & JSONObject) | ({ status: string; code?: number } & JSONObject)>,
): PluginRouteHandler['handler'] => {
  return async (req, res, session, userContext) => {
    const result = await fn(req, res, session, userContext);

    if (result.status === 'OK') {
      res.setStatusCode(200);
    } else {
      res.setStatusCode(Number(result.code) || 400);
    }

    res.sendJSONResponse(result);

    return null;
  };
};
