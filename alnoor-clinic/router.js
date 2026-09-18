// router.js — a minimal Express-shaped router with zero dependencies.
// Each route module calls router.get/post/put/del(matcher, handler) where matcher
// is either an exact path string or a RegExp with capture groups. dispatch() finds
// the first match and calls the handler as (req, res, match, url), where `match`
// is the RegExp exec array (params in match[1], match[2], ...) or null for a
// string match.

function createRouter() {
  const routes = [];
  function add(method, matcher, handler) { routes.push({ method, matcher, handler }); }
  return {
    get: (matcher, handler) => add('GET', matcher, handler),
    post: (matcher, handler) => add('POST', matcher, handler),
    put: (matcher, handler) => add('PUT', matcher, handler),
    del: (matcher, handler) => add('DELETE', matcher, handler),
    routes
  };
}

// Merges several routers' route tables into one flat list for dispatch.
function mergeRouters(...routers) {
  return routers.flatMap(r => r.routes);
}

async function dispatch(allRoutes, req, res, pathname, url) {
  for (const route of allRoutes) {
    if (route.method !== req.method) continue;
    if (typeof route.matcher === 'string') {
      if (route.matcher === pathname) { await route.handler(req, res, null, url); return true; }
    } else {
      const match = pathname.match(route.matcher);
      if (match) { await route.handler(req, res, match, url); return true; }
    }
  }
  return false;
}

module.exports = { createRouter, mergeRouters, dispatch };
