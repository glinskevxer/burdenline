/**
 * A description of the api, generated from the routes that are actually
 * registered.
 *
 * Not a full specification document. What it is for is the question a person
 * integrating with this asks first, which is what routes exist and what each one
 * needs, and the value of generating it is that it cannot drift: a route added
 * without a schema shows up in the description as having no schema, which is
 * exactly the nudge that gets one written.
 */

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function describeRoutes(routes) {
  const described = routes
    .filter((route) => !route.url.startsWith('/describe'))
    // Fastify adds a HEAD for every GET. It is the same route and listing it
    // twice makes the description twice as long and no more useful.
    .filter((route) => route.method !== 'HEAD')
    .map((route) => ({
      method: route.method,
      path: route.url,
      grant: route.grant ?? null,
      body: summariseSchema(route.schema?.body),
      query: summariseSchema(route.schema?.querystring),
      hasSchema: Boolean(route.schema?.body || route.schema?.querystring),
    }));
  described.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return described;
}

export function summariseSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return {
    required: [...required].sort(),
    fields: Object.entries(properties)
      .map(([name, definition]) => ({
        name,
        type: definition.type ?? 'any',
        required: required.has(name),
        ...(definition.enum ? { values: definition.enum } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allowsUnknown: schema.additionalProperties !== false,
  };
}

/**
 * Register the description route. It collects routes as they are added, which is
 * why it goes on last: fastify has no public route table until the server is
 * ready and this is cheaper than waiting for it.
 */
export function registerDescribe(app) {
  const collected = [];

  app.addHook('onRoute', (route) => {
    for (const method of [].concat(route.method)) {
      collected.push({
        method,
        url: route.url,
        schema: route.schema,
        grant: route.config?.grant ?? null,
      });
    }
  });

  app.get('/describe', async () => {
    const routes = describeRoutes(collected);
    return {
      service: 'burdenline',
      routeCount: routes.length,
      withoutSchema: routes.filter((route) => !route.hasSchema && route.method !== 'GET').length,
      routes,
    };
  });

  return app;
}
