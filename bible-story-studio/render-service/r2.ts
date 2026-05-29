import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile, writeFile } from "node:fs/promises";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

/** Download an R2 object to a local file path. */
export async function r2Download(bucket: string, key: string, dest: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`R2 object not found: ${key}`);
  const bytes = await res.Body.transformToByteArray();
  await writeFile(dest, bytes);
}

/** Upload a local file to R2. */
export async function r2Upload(
  bucket: string,
  key: string,
  src: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(src);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}
