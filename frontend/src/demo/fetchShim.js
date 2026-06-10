// Static-demo fetch shim — serves the captured API fixtures so the real app
// runs fully client-side (GitHub Pages, any static host). Reads are answered
// from fixtures; writes succeed as no-ops so the UI stays explorable.
import fixtures from './fixtures.json';

const realFetch = window.fetch.bind(window);

window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  let u;
  try { u = new URL(url, window.location.origin); } catch { return realFetch(input, init); }
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);

  const method = (init.method || 'GET').toUpperCase();
  const json = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));

  if (method === 'GET') {
    const hit = fixtures['GET ' + u.pathname + u.search] ?? fixtures['GET ' + u.pathname];
    if (hit !== undefined) return json(hit);
    return json({ error: 'Not captured in the static demo' }, 404);
  }
  // Mutations are simulated — the demo is read-only by design.
  return json({ ok: true, demo: true, simulated: true });
};
