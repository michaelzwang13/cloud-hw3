const { LexRuntimeV2Client, RecognizeTextCommand } = require("@aws-sdk/client-lex-runtime-v2");
const { SignatureV4 } = require("@smithy/signature-v4");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { HttpRequest } = require("@smithy/protocol-http");
const { Hash } = require("@smithy/hash-node");
const Sha256 = Hash.bind(null, "sha256");
const https = require("https");
const crypto = require("crypto");

const REGION = process.env.AWS_REGION || "us-east-1";
const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || "photos";
const BOT_ID = process.env.LEX_BOT_ID;
const BOT_ALIAS_ID = process.env.LEX_BOT_ALIAS_ID || "TSTALIASID";
const LOCALE_ID = process.env.LEX_LOCALE_ID || "en_US";

const lex = new LexRuntimeV2Client({ region: REGION });

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-api-key",
};

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  const method = event.httpMethod || event.requestContext?.http?.method;
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  const q = (event.queryStringParameters && event.queryStringParameters.q) || "";
  if (!q.trim()) {
    return respond(200, { results: [] });
  }

  const keywords = await disambiguate(q);
  console.log("Keywords:", keywords);
  if (keywords.length === 0) {
    return respond(200, { results: [] });
  }

  const hits = await searchPhotos(keywords);
  const results = hits.map((h) => ({
    url: photoUrl(h._source.bucket, h._source.objectKey),
    labels: h._source.labels || [],
  }));
  return respond(200, { results });
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function photoUrl(bucket, objectKey) {
  const safeKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return `https://${bucket}.s3.amazonaws.com/${safeKey}`;
}

async function disambiguate(q) {
  if (!BOT_ID) throw new Error("LEX_BOT_ID env var is not set");

  const sessionId = crypto.randomBytes(16).toString("hex");
  const resp = await lex.send(new RecognizeTextCommand({
    botId: BOT_ID,
    botAliasId: BOT_ALIAS_ID,
    localeId: LOCALE_ID,
    sessionId,
    text: q,
  }));

  const slots = resp.sessionState?.intent?.slots || {};
  const keywords = [];
  for (const slot of Object.values(slots)) {
    if (!slot) continue;
    const v = slot.value?.interpretedValue || slot.value?.originalValue;
    if (v) keywords.push(String(v).toLowerCase().trim());
  }
  return Array.from(new Set(keywords.filter(Boolean)));
}

async function searchPhotos(keywords) {
  const body = {
    size: 50,
    query: {
      bool: {
        should: keywords.map((k) => ({ match: { labels: k } })),
        minimum_should_match: 1,
      },
    },
  };
  try {
    const data = await esRequest("POST", `/${OPENSEARCH_INDEX}/_search`, body);
    return data.hits?.hits || [];
  } catch (e) {
    if (/OpenSearch 404/.test(e.message) && /index_not_found_exception/.test(e.message)) {
      return [];
    }
    throw e;
  }
}

async function esRequest(method, path, body) {
  if (!OPENSEARCH_ENDPOINT) throw new Error("OPENSEARCH_ENDPOINT env var is not set");

  const host = OPENSEARCH_ENDPOINT.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const bodyStr = body ? JSON.stringify(body) : undefined;

  const request = new HttpRequest({
    method,
    protocol: "https:",
    hostname: host,
    path,
    headers: {
      "Content-Type": "application/json",
      host,
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr).toString() } : {}),
    },
    body: bodyStr,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: "es",
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: signed.hostname,
        path: signed.path,
        method: signed.method,
        headers: signed.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`OpenSearch ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (signed.body) req.write(signed.body);
    req.end();
  });
}
