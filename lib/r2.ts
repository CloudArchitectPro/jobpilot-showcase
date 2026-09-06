import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID!;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

// Set via env in production — no default bucket name is baked into source.
export const R2_BUCKET = process.env.R2_BUCKET_NAME!;

export function extFromFilename(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx) : "";
}

/**
 * Namespaces every object by owner and job, so per-user documents can never
 * collide even if two owners are working with jobs that share an id space.
 */
export function objectKey(
  ownerId: string,
  jobId: string,
  kind: "resume" | "cover_letter" | "tailored_resume" | "tailored_cover_letter",
  ext: string
): string {
  return `${ownerId}/${jobId}/${kind}${ext}`;
}

/**
 * Uploads a buffer to R2 under the given key. Caller persists the key
 * (e.g. to `jobs.tailored_resume_path`) — this function only handles the
 * object write itself.
 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

/**
 * Time-limited signed URL for downloading an existing R2 object, instead of
 * streaming file bytes through the app server on every request.
 * Default expiry: 5 minutes — long enough for a browser download to start,
 * short enough that a leaked link isn't useful for long.
 */
export async function getR2SignedUrl(
  key: string,
  expiresInSeconds = 300
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });
  return getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
}
