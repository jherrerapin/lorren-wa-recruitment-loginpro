import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function isStorageConfigured() {
  return Boolean(
    process.env.R2_ENDPOINT
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_BUCKET
  );
}

function getStorageClient() {
  if (!isStorageConfigured()) {
    throw new Error('R2 storage is not configured');
  }

  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadBufferToR2(key, buffer, contentType, options = {}) {
  const s3 = getStorageClient();
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {})
  }));
}

export async function getSignedDownloadUrl(key) {
  const s3 = getStorageClient();
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  });
  return getSignedUrl(s3, command, { expiresIn: 300 });
}

export async function downloadBufferFromR2(key) {
  const s3 = getStorageClient();
  const response = await s3.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
  return streamToBuffer(response.Body);
}

export async function deleteObjectFromR2(key) {
  if (!key || !isStorageConfigured()) return;
  const s3 = getStorageClient();
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
}

export { isStorageConfigured };
