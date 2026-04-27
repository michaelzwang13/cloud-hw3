const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET = process.env.BUCKET || "photos-b2-520531809354";

const s3 = new S3Client({ region: REGION });

const TARGET_COUNT = parseInt(process.env.TARGET_COUNT || "50", 10);

function download(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} → ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function uploadBuffer(buf, key, customLabels) {
  const metadata = customLabels ? { customLabels } : undefined;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: "image/jpeg",
    Metadata: metadata,
  }));
  console.log(`  uploaded → s3://${BUCKET}/${key}` + (customLabels ? `  [${customLabels}]` : ""));
}

function followRedirects(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error("too many redirects"));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).toString();
        return followRedirects(next, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} → ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function uploadPicsumSamples() {
  console.log(`Downloading ${TARGET_COUNT} photos from picsum.photos and uploading to s3://${BUCKET}/`);
  let success = 0;
  for (let seed = 1; seed <= TARGET_COUNT; seed++) {
    const url = `https://picsum.photos/seed/photo${seed}/800/600.jpg`;
    try {
      const buf = await followRedirects(url);
      await uploadBuffer(buf, `picsum-${seed}.jpg`);
      success++;
    } catch (e) {
      console.error(`  ✗ seed=${seed}: ${e.message}`);
    }
  }
  console.log(`Uploaded ${success}/${TARGET_COUNT}.`);
}

async function uploadLocalDir(dir) {
  const entries = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
  console.log(`Uploading ${entries.length} files from ${dir} to s3://${BUCKET}/`);
  for (const f of entries) {
    const buf = fs.readFileSync(path.join(dir, f));
    try {
      await uploadBuffer(buf, f);
    } catch (e) {
      console.error(`  ✗ ${f}: ${e.message}`);
    }
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--picsum") {
    await uploadPicsumSamples();
  } else if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
    await uploadLocalDir(arg);
  } else {
    console.error("Usage:");
    console.error("  node bulk-upload.js                # upload COCO samples");
    console.error("  node bulk-upload.js /path/to/dir   # upload all .jpg/.png in dir");
    process.exit(1);
  }
  console.log("Done. Wait ~10s, then check OpenSearch:");
  console.log("  aws lambda invoke --function-name photos-LF2 --payload '{\"queryStringParameters\":{\"q\":\"dog\"}}' --cli-binary-format raw-in-base64-out /tmp/r.json && cat /tmp/r.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
