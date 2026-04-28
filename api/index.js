import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const UPSTREAM_ROOT = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

function collectOutgoingHeaders(sourceHeaders) {
  const forwardHeaders = {};
  let detectedClientIp = null;

  for (const headerName of Object.keys(sourceHeaders)) {
    const normalizedName = headerName.toLowerCase();
    const headerValue = sourceHeaders[headerName];

    if (HOP_BY_HOP_HEADERS.has(normalizedName)) continue;
    if (normalizedName.startsWith("x-vercel-")) continue;

    if (normalizedName === "x-real-ip") {
      detectedClientIp = headerValue;
      continue;
    }

    if (normalizedName === "x-forwarded-for") {
      if (!detectedClientIp) detectedClientIp = headerValue;
      continue;
    }

    forwardHeaders[normalizedName] = Array.isArray(headerValue)
      ? headerValue.join(", ")
      : headerValue;
  }

  if (detectedClientIp) {
    forwardHeaders["x-forwarded-for"] = detectedClientIp;
  }

  return forwardHeaders;
}

export default async function relayHandler(request, response) {
  if (!UPSTREAM_ROOT) {
    response.statusCode = 500;
    return response.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    const destination = UPSTREAM_ROOT + request.url;
    const methodType = request.method;
    const requiresBody = methodType !== "GET" && methodType !== "HEAD";

    const outboundHeaders = collectOutgoingHeaders(request.headers);

    const requestOptions = {
      method: methodType,
      headers: outboundHeaders,
      redirect: "manual",
    };

    if (requiresBody) {
      requestOptions.body = Readable.toWeb(request);
      requestOptions.duplex = "half";
    }

    const upstreamResponse = await fetch(destination, requestOptions);

    response.statusCode = upstreamResponse.status;

    for (const [headerKey, headerValue] of upstreamResponse.headers) {
      if (headerKey.toLowerCase() === "transfer-encoding") continue;
      try {
        response.setHeader(headerKey, headerValue);
      } catch {}
    }

    if (upstreamResponse.body) {
      await pipeline(Readable.fromWeb(upstreamResponse.body), response);
    } else {
      response.end();
    }
  } catch (error) {
    console.error("relay error:", error);
    if (!response.headersSent) {
      response.statusCode = 502;
      response.end("Bad Gateway: Tunnel Failed");
    }
  }
}
