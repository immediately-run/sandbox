// DEAD-CANDIDATE(2026-06): local-only Fastify prod-test server (`npm start`,
// inherited from upstream sandpack-bundler). The immediately.run deploy path is
// Firebase Hosting serving `dist/` (firebase.json) — server.js is never invoked in
// production. Kept for local prod-build testing, not removed. See
// DEPRECATION_CANDIDATES.md.
const fastify = require("fastify");
const fastifyStatic = require("fastify-static");
const path = require("path");

const PORT = +(process.env.PORT || "4587");

const app = fastify();

app.register(fastifyStatic, {
  root: path.join(__dirname, "dist"),
  prefix: "/",
  cacheControl: true,
  dotfiles: "deny",
  etag: true,
  immutable: true,
  maxAge: 31 * 24 * 60 * 60 * 1000,
});

// Fallback to index.html, it's a SPA
app.setNotFoundHandler((req, reply) => {
  console.log("Sending index.html instead of requested file", req.path)
  return reply.sendFile("index.html", { cacheControl: false });
});

// Run the server!
app.listen(PORT, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Server is now listening on ${address}
  console.log(`Server is listening on http://localhost:${PORT}`);
});
