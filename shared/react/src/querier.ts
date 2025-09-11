export class QuerierError extends Error {
  constructor(
    message: string,
    public payload: any,
  ) {
    super(message);
  }
}

const post =
  (basePath: string) =>
  async <T>(
    path: string,
    body: any,
    { withSession, params }: { withSession: boolean; params?: Record<string, string> },
  ): Promise<T> => {
    const queryParams = params ? `?${new URLSearchParams(params).toString()}` : "";

    const url = `${basePath}${path}${queryParams}`;

    const credentials: { credentials?: "include" } = {};
    if (withSession) {
      credentials.credentials = "include";
    }

    const response = await fetch(url, {
      ...credentials,
      method: "POST",
      headers: {
        "Content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      let payload = error;
      try {
        payload = JSON.parse(error);
      } catch (e) {}

      throw new QuerierError(`Fetch failed: ${error}`, payload);
    }

    return response.json() as Promise<T>;
  };

const get =
  (basePath: string) =>
  async <T>(
    path: string,
    { withSession, params }: { withSession: boolean; params?: Record<string, string> },
  ): Promise<T> => {
    const queryParams = params ? `?${new URLSearchParams(params).toString()}` : "";

    const url = `${basePath}${path}${queryParams}`;

    let response;
    try {
      response = await fetch(url, {
        cache: "no-cache",
        credentials: withSession ? "include" : "omit",
        method: "GET",
        headers: {
          "Content-type": "application/json",
          Accept: "application/json",
        },
      });
    } catch (error) {
      const newError = new Error(`Fetch failed: ${error}`);
      let payload = error;
      try {
        payload = JSON.parse(error as string);
      } catch (e) {}
      // @ts-ignore
      newError.payload = payload;
      throw newError;
    }

    if (!response.ok) {
      const error = await response.text();
      const newError = new Error(`Fetch failed: ${error}`);
      let payload = error;
      try {
        payload = JSON.parse(error);
      } catch (e) {}
      // @ts-ignore
      newError.payload = payload;
      throw newError;
    }

    return response.json() as Promise<T>;
  };

export const getQuerier = (basePath: string) => {
  return { get: get(basePath), post: post(basePath) };
};
