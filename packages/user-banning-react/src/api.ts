import { getQuerier } from './querier';

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const getBanStatus = async (tenantId: string, email: string) => {
    return await querier.get<
      { status: 'OK'; banned: boolean } | { status: 'ERROR'; message: string }
    >('/ban', {
      withSession: true,
      params: { tenantId, email },
    });
  };

  const updateBanStatus = async (
    tenantId: string,
    email: string,
    isBanned: boolean
  ) => {
    return await querier.post<
      { status: 'OK' } | { status: 'ERROR'; message: string }
    >(
      '/ban',
      { email, isBanned },
      {
        withSession: true,
        params: { tenantId },
      }
    );
  };

  return {
    getBanStatus,
    updateBanStatus,
  };
};
