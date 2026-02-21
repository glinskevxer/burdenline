/**
 * The rule numbers a site runs on, over HTTP.
 *
 * The read is open to anybody who can read the site, because a shotfirer
 * arguing with a refusal deserves to see the number it was refused against.
 * Setting one needs the administer grant and takes a note, since a rule changed
 * without a reason is a rule that gets changed back next week.
 */

import * as siteRules from '../../db/repositories/site-rules.js';

export function siteRuleRoutes(app) {
  const { db, clock } = app.deps;
  const context = { clock };

  app.get('/rule-sets', { preHandler: app.requireGrant('read') }, async () => ({
    ruleSets: siteRules.ruleSetNames().map((name) => ({
      name,
      defaults: siteRules.defaultsFor(name),
    })),
  }));

  app.get('/sites/:siteId/rules', { preHandler: app.requireGrant('read') }, async (request) => ({
    rules: siteRules.allRulesFor(db, request.params.siteId),
  }));

  app.get(
    '/sites/:siteId/rules/:ruleSet',
    { preHandler: app.requireGrant('read') },
    async (request) => ({
      rules: siteRules.rulesFor(db, request.params.siteId, request.params.ruleSet),
      history: siteRules.history(db, request.params.siteId, request.params.ruleSet),
    }),
  );

  app.put(
    '/sites/:siteId/rules/:ruleSet',
    {
      preHandler: app.requireGrant('administer'),
      schema: {
        body: {
          type: 'object',
          required: ['values'],
          additionalProperties: false,
          properties: {
            values: { type: 'object' },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request) => ({
      rules: siteRules.setRules(
        db,
        {
          siteId: request.params.siteId,
          ruleSet: request.params.ruleSet,
          values: request.body.values,
          setBy: request.actor.id,
          note: request.body.note ?? null,
        },
        context,
      ),
    }),
  );

  app.delete(
    '/sites/:siteId/rules/:ruleSet',
    { preHandler: app.requireGrant('administer') },
    async (request) => ({
      rules: siteRules.resetRules(
        db,
        { siteId: request.params.siteId, ruleSet: request.params.ruleSet, setBy: request.actor.id },
        context,
      ),
    }),
  );

  return app;
}
