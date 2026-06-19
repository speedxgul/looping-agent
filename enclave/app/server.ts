// Trivial enclave app. The attestation is handled by Oyster's enclave image
// (port 1300) — this is just *some* workload running inside the TEE so we can
// confirm the container runs and is reachable alongside the attestation.
const PORT = 8080;

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response('ok\n');
    }
    return Response.json({
      message: 'hello from inside the enclave',
      path: url.pathname,
      at: new Date().toISOString()
    });
  }
});

console.log(`enclave app listening on :${PORT}`);
