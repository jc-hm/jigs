import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendRawEmailCommand, SESClient } from "@aws-sdk/client-ses";

const s3 = new S3Client({});
const ses = new SESClient({ region: process.env.AWS_REGION });

type Verdict = { status: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" };

interface SesEvent {
  Records: Array<{
    ses: {
      mail: {
        messageId: string;
        source: string;
        destination: string[];
        commonHeaders: { from?: string[]; subject?: string };
      };
      receipt: {
        spamVerdict: Verdict;
        virusVerdict: Verdict;
      };
    };
  }>;
}

export const handler = async (event: SesEvent): Promise<void> => {
  const { mail, receipt } = event.Records[0].ses;
  const { messageId, source, destination, commonHeaders } = mail;

  // Viruses: drop silently — never forward malware.
  if (receipt.virusVerdict.status === "FAIL") {
    console.log(JSON.stringify({ type: "virus_blocked", from: source }));
    return;
  }

  // Spam: move to spam/ prefix in S3 for manual review, don't forward.
  // Keeps the domain clean while preserving the email for inspection.
  if (receipt.spamVerdict.status === "FAIL") {
    console.log(JSON.stringify({ type: "spam_detected", from: source }));
    await s3.send(new CopyObjectCommand({
      Bucket: process.env.BUCKET!,
      CopySource: `${process.env.BUCKET}/incoming/${messageId}`,
      Key: `spam/${messageId}`,
    }));
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.BUCKET!,
      Key: `incoming/${messageId}`,
    }));
    return;
  }
  // The address that received the email becomes the From when forwarding,
  // so replies in Gmail go back to original sender via Reply-To.
  const fromAddress = destination[0] ?? process.env.DEFAULT_FROM!;
  const replyTo = commonHeaders.from?.[0] ?? source;

  const obj = await s3.send(new GetObjectCommand({
    Bucket: process.env.BUCKET!,
    Key: `incoming/${messageId}`,
  }));

  const chunks: Uint8Array[] = [];
  for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");

  // Split at first blank line (end of header section)
  const sep = raw.search(/\r?\n\r?\n/);
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep) : "\r\n\r\n";

  // Remove headers we rewrite + headers that become invalid after forwarding
  const stripped = headerBlock
    .replace(
      /^(DKIM-Signature|ARC-[^:]+|From|To|Cc|Bcc|Return-Path):[ \t]*[^\n]*(\r?\n[ \t][^\n]*)*/gim,
      "",
    )
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .join("\r\n");

  const newHeaders = [
    `From: <${fromAddress}>`,
    `Reply-To: ${replyTo}`,
    `To: ${process.env.FORWARD_TO}`,
    stripped,
  ]
    .filter(Boolean)
    .join("\r\n");

  await ses.send(
    new SendRawEmailCommand({
      Source: fromAddress,
      Destinations: [process.env.FORWARD_TO!],
      RawMessage: { Data: Buffer.from(newHeaders + body) },
    }),
  );
};
