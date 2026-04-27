const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, DetectLabelsCommand } = require("@aws-sdk/client-rekognition");
const { SignatureV4 } = require("@smithy/signature-v4");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { HttpRequest } = require("@smithy/protocol-http");
const { Hash } = require("@smithy/hash-node");
const Sha256 = Hash.bind(null, "sha256");
const https = require("https");

const REGION = process.env.AWS_REGION || "us-east-1";
const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || "photos";

const s3 = new S3Client({ region: REGION });
const rekognition = new RekognitionClient({ region: REGION });

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  const results = [];
  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const eventTime = record.eventTime;

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    const customLabelsRaw = (head.Metadata && head.Metadata["customlabels"]) || "";
    const a1 = customLabelsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const rekResp = await rekognition.send(new DetectLabelsCommand({
      Image: { S3Object: { Bucket: bucket, Name: objectKey } },
      MaxLabels: 10,
      MinConfidence: 75,
    }));
    for (const l of rekResp.Labels || []) a1.push(l.Name);

    const labels = Array.from(new Set(a1));
    const createdTimestamp = eventTime.replace(/\.\d+Z$/, "").replace(/Z$/, "");

    const doc = {
      objectKey,
      bucket,
      createdTimestamp,
      labels,
    };

    await indexDocument(doc);
    results.push({ objectKey, labels });
  }

  return { statusCode: 200, body: JSON.stringify(results) };
};

async function indexDocument(doc) {
  if (!OPENSEARCH_ENDPOINT) throw new Error("OPENSEARCH_ENDPOINT env var is not set");

  const host = OPENSEARCH_ENDPOINT.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const path = `/${OPENSEARCH_INDEX}/_doc`;
  const body = JSON.stringify(doc);

  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path,
    headers: {
      "Content-Type": "application/json",
      host,
    },
    body,
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
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`OpenSearch ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on("error", reject);
    req.write(signed.body);
    req.end();
  });
}
