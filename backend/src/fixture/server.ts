import http from "node:http";

/**
 * A small, fully local application used to verify discovery and execution without touching a
 * third-party site. It is a TEST FIXTURE: nothing here is served to users, and no platform code
 * path reads from it. The "credentials" below are fixture constants, not secrets.
 */

const layout = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/form">Form</a> <a href="/login">Sign in</a></nav>${body}</body></html>`;

const pages: Record<string, string> = {
  "/": layout("Fixture Home", `<h1>Fixture Home</h1><p>Safe local discovery fixture.</p><button id="home-button" data-testid="home-action" aria-label="Open home action">Action</button>`),
  "/about": layout("About Fixture", `<h1>About</h1><p>About page.</p><button role="button">Continue</button>`),
  // Fetches a JSON endpoint on load, so the crawler has real XHR traffic to build an endpoint
  // inventory from. A script tag adds no link, form, or interactive element, so the existing
  // discovery counts are unaffected.
  "/products": layout(
    "Products Fixture",
    `<h1>Products</h1><ul><li><a href="/product/one">Product one</a></li></ul><div id="live"></div><script>fetch('/api/products?page=1').then(r=>r.json()).then(d=>{document.getElementById('live').textContent=d.items.length+' items'});</script>`,
  ),
  "/product/one": layout("Product One", `<h1>Product one</h1><p data-testid="price">$19.00</p>`),
  "/form": layout(
    "Form Fixture",
    `<h1>Contact</h1><form id="contact-form" action="/form" method="post"><label for="name">Name</label><input id="name" name="name" placeholder="Your name" required autocomplete="name"><label>Email<input name="email" type="email" autocomplete="email"></label><label for="kind">Kind</label><select id="kind" name="kind"><option>Question</option><option>Feedback</option></select><label><input name="updates" type="checkbox">Updates</label><button type="submit">Send</button></form>`,
  ),
  "/login": layout(
    "Sign in Fixture",
    `<h1>Sign in</h1><form id="login-form" method="post" action="/login"><label for="username">Username</label><input id="username" name="username" data-testid="username" autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" data-testid="password" autocomplete="current-password"><button type="submit" data-testid="signin">Sign in</button></form>`,
  ),
};

/** Fixture-only constants. Real credentials never live in this repository. */
const FIXTURE_USER = "demo";
const FIXTURE_PASSWORD = "demo-fixture-password";

function handleLogin(body: string) {
  const form = new URLSearchParams(body);
  const ok = form.get("username") === FIXTURE_USER && form.get("password") === FIXTURE_PASSWORD;
  return {
    status: ok ? 200 : 401,
    html: ok
      ? layout("Dashboard Fixture", `<h1>Dashboard</h1><p data-testid="welcome">Welcome back, ${FIXTURE_USER}</p>`)
      : layout("Sign in Fixture", `<h1>Sign in</h1><p data-testid="login-error" role="alert">Invalid username or password</p><form id="login-form" method="post" action="/login"><label for="username">Username</label><input id="username" name="username" data-testid="username"><label for="password">Password</label><input id="password" name="password" type="password" data-testid="password"><button type="submit" data-testid="signin">Sign in</button></form>`),
  };
}

export function createFixtureServer(port = 4317) {
  const server = http.createServer((request, response) => {
    const url = request.url?.split("?")[0] ?? "/";
    const send = (status: number, html: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      response.end(html);
    };

    if (request.method === "POST" && (url === "/login" || url === "/form")) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (url === "/form") return send(200, layout("Thanks Fixture", `<h1>Thanks</h1><p data-testid="result">Thanks, we received your message.</p>`));
        const result = handleLogin(Buffer.concat(chunks).toString());
        send(result.status, result.html);
      });
      return;
    }

    // A JSON endpoint the pages call themselves. Fixture data only.
    if (url === "/api/products") {
      const json = JSON.stringify({ items: [{ id: 1, name: "Product one", price: 1900 }] });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
      return response.end(json);
    }

    const body = pages[url];
    if (!body) return send(404, layout("Not found", "<h1>Not found</h1>"));
    send(200, body);
  });

  return {
    server,
    start: () => new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)),
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}/`,
    credentials: { username: FIXTURE_USER, password: FIXTURE_PASSWORD },
  };
}

if (require.main === module) createFixtureServer().start().then(() => console.log("Crawler fixture listening on http://127.0.0.1:4317"));
