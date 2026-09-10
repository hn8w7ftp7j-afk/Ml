// Expose only the real route preparation functions to this isolated regression
// test. Production exports and execution remain unchanged.
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'next/server' ? 'next/server.js' : specifier, context);
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const helper = url.endsWith('/app/api/analyze/route.js') ? 'prepareMarketRows'
    : url.endsWith('/app/api/reprice/route.js') ? 'prepareMarkets' : null;
  if (!helper) return loaded;
  return { ...loaded, source: `${loaded.source}\nexport { ${helper} as prepareAuthenticatedMarketsForTest };\n` };
}
