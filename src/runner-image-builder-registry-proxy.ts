/**
 * The Container sends registry traffic to its outbound proxy over an encrypted
 * in-platform HTTP hop. The Worker must use verified HTTPS to reach the
 * account-private registry.
 */
export function privateRegistryUpstreamUrl(requestUrl: string): URL {
  const upstream = new URL(requestUrl);
  upstream.protocol = "https:";
  return upstream;
}

/**
 * The builder may only use the account credential for its managed runner-image
 * repository. Dockerfile commands therefore cannot use the loopback proxy to
 * read or write any other private registry repository in the account.
 */
export function privateRegistryRequestIsAllowed(request: Request, repository: string): boolean {
  const url = new URL(request.url);
  const expectedPath = `/v2/${repository}/`;
  const registryApiPing = url.pathname === "/v2/" && (request.method === "GET" || request.method === "HEAD");
  // A cross-repository blob mount would make the managed repository a read
  // path for layers from an arbitrary private repository in this account.
  const requestsForeignBlobMount = url.searchParams.has("from") || url.searchParams.has("mount");
  return (
    url.hostname === "registry.cloudflare.com" &&
    !requestsForeignBlobMount &&
    (registryApiPing ||
      (url.pathname.startsWith(expectedPath) && ["GET", "HEAD", "POST", "PUT", "PATCH"].includes(request.method)))
  );
}

/**
 * Reissue an intercepted in-platform HTTP request as verified HTTPS from the
 * Worker. This lets a builder use plain HTTP only for the encrypted local hop
 * while public registries remain normal TLS connections from Cloudflare.
 */
export function verifiedHttpsProxyRequest(request: Request): Request {
  // Node's Fetch implementation requires duplex for a streamed body; Workers
  // accepts the standard request unchanged.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // The Container interception request is manual. Follow Docker Hub's
    // short-lived layer redirects here instead, so a signed CloudFront URL is
    // fetched with verified Worker TLS and never exposed to Kaniko.
    redirect: "follow",
    duplex: "half",
  };
  return new Request(privateRegistryUpstreamUrl(request.url), init);
}

/** Forward an intercepted Container request through verified Worker HTTPS. */
export function proxyVerifiedHttpsRequest(request: Request): Promise<Response> {
  return fetch(verifiedHttpsProxyRequest(request));
}

/**
 * Docker Hub advertises its anonymous token endpoint as HTTPS in the registry
 * challenge. Kaniko follows that URL directly, so rewrite just that internal
 * hop to HTTP. The bound Worker entrypoint immediately upgrades it back to
 * verified HTTPS before it leaves Cloudflare.
 */
export function dockerHubChallengeResponse(response: Response): Response {
  const challenge = response.headers.get("WWW-Authenticate");
  if (challenge === null || !challenge.includes("https://auth.docker.io/")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("WWW-Authenticate", challenge.replaceAll("https://auth.docker.io/", "http://auth.docker.io/"));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Forward a Docker Hub request through verified HTTPS and patch its auth challenge. */
export async function proxyDockerHubRequest(request: Request): Promise<Response> {
  return dockerHubChallengeResponse(await proxyVerifiedHttpsRequest(request));
}

/**
 * Coalesce concurrent registry requests onto one short-lived credential. The
 * Containers credential endpoint can rotate a credential as it issues a new
 * one, so parallel layer requests must share the same value.
 */
export class RegistryAuthorizationCache {
  private authorization: string | undefined;
  private expiresAt = 0;
  private pending: Promise<string> | undefined;

  async get(load: () => Promise<string>, now = Date.now()): Promise<string> {
    if (this.authorization !== undefined && now < this.expiresAt) {
      return this.authorization;
    }
    if (this.pending !== undefined) {
      return this.pending;
    }
    const pending = load().then((authorization) => {
      this.authorization = authorization;
      // Credentials last 15 minutes. Refresh one minute early so no long layer
      // upload begins with a credential that could expire during its request.
      this.expiresAt = now + 14 * 60 * 1_000;
      return authorization;
    });
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    }
  }
}

/** Preserve the registry client's method and streaming body, then attach Worker-only credentials. */
export function privateRegistryProxyRequest(request: Request, authorization: string): Request {
  // Node's Fetch implementation requires duplex for a streamed body; Workers
  // accepts the standard request unchanged. Keep the field local to this
  // bridge so the rest of the Worker uses the normal RequestInit type.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: (() => {
      const headers = new Headers(request.headers);
      headers.set("Authorization", authorization);
      return headers;
    })(),
    body: request.body,
    redirect: request.redirect,
    duplex: "half",
  };
  return new Request(privateRegistryUpstreamUrl(request.url), init);
}

/** Forward one intercepted Container-registry request to verified HTTPS. */
export function proxyPrivateRegistryRequest(request: Request, authorization: string): Promise<Response> {
  return fetch(privateRegistryProxyRequest(request, authorization));
}
