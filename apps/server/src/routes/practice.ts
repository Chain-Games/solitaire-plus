import type { FastifyPluginAsync } from 'fastify';

/**
 * Practice: free, client-only play. The client only needs a deal, and a
 * practice seed is no secret (nothing is staked on it), so this needs no
 * session. The seed comes from the practice pool, whose namespace never
 * deals a challenge (services/deals.ts).
 */
export const practiceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/deal', async (_req, reply) => {
    const { seed } = await app.deals.popPracticeSeed();
    void reply.header('cache-control', 'no-store');
    return { seed };
  });
};
