import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfileForAuthUser, hasAdminAccess } from "@/lib/auth/profile";
import { getGmailClient } from "@/lib/email/gmail";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_IN_TEXT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

type SendEmailRequestBody = {
  zip_filename?: unknown;
  account_key?: unknown;
  trade_date?: unknown;
  to_email?: unknown;
  to_name?: unknown;
  filename?: unknown;
  pdf_base64?: unknown;
};

type SendLogInput = {
  zip_filename: string;
  account_key: string;
  trade_date: string | null;
  to_email: string;
  to_name: string | null;
  status: "sent" | "failed";
  error: string | null;
  message_id: string | null;
  sent_by_auth_user_id: string;
};

function badRequest(error: string) {
  return Response.json(
    {
      ok: false,
      provider: "gmail",
      error
    },
    { status: 400 }
  );
}

function toStringOrEmpty(value: unknown): string {
  return String(value ?? "").trim();
}

function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const [local, domain] = normalized.split("@");

  if (!local || !domain) {
    return "***";
  }

  if (local.length <= 2) {
    return `${local[0] ?? "*"}***@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(EMAIL_IN_TEXT_PATTERN, (match) => maskEmail(match));
}

function wrapBase64Lines(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  text: string;
  filename: string;
  pdfBuffer: Buffer;
}): string {
  const boundary = `boundary_${Date.now().toString(36)}`;
  const safeFilename = params.filename.replace(/"/g, "");
  const attachmentBase64 = wrapBase64Lines(params.pdfBuffer.toString("base64"));

  const rawMessage = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    params.text,
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${safeFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "",
    attachmentBase64,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");

  return base64UrlEncode(rawMessage);
}

async function writeSendLog(supabase: SupabaseClient, log: SendLogInput) {
  try {
    const { error } = await supabase.from("send_logs").insert(log);

    if (error) {
      console.error("send_logs insert failed");
    }
  } catch {
    console.error("send_logs insert failed");
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: claimsData,
    error: claimsError
  } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(!claimsError && claimsData?.claims);

  if (!isAuthenticated) {
    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: "Not authorized."
      },
      { status: 401 }
    );
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: "Not authorized."
      },
      { status: 401 }
    );
  }

  const profile = await getProfileForAuthUser(supabase, user.id);
  if (!hasAdminAccess(user.email, profile.role)) {
    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: "Not authorized."
      },
      { status: 401 }
    );
  }

  let body: SendEmailRequestBody;
  try {
    body = (await request.json()) as SendEmailRequestBody;
  } catch {
    return badRequest("Invalid request body.");
  }

  const zipFilename = toStringOrEmpty(body.zip_filename);
  const accountKey = toStringOrEmpty(body.account_key);
  const tradeDateRaw = toStringOrEmpty(body.trade_date);
  const tradeDate = tradeDateRaw || null;
  const toEmail = toStringOrEmpty(body.to_email).toLowerCase();
  const toName = toStringOrEmpty(body.to_name) || null;
  const filename = toStringOrEmpty(body.filename);
  const pdfBase64 = toStringOrEmpty(body.pdf_base64);

  if (!zipFilename) {
    return badRequest("zip_filename is required.");
  }

  if (!accountKey) {
    return badRequest("account_key is required.");
  }

  if (!EMAIL_PATTERN.test(toEmail) || !toEmail.includes("@")) {
    return badRequest("to_email must be a valid email address.");
  }

  if (!filename.toLowerCase().endsWith(".pdf")) {
    return badRequest("filename must end with .pdf.");
  }

  if (!pdfBase64) {
    return badRequest("pdf_base64 is required.");
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = Buffer.from(pdfBase64, "base64");
  } catch {
    return badRequest("pdf_base64 must be valid base64.");
  }

  if (pdfBuffer.length === 0) {
    return badRequest("pdf attachment must be non-empty.");
  }

  const senderEmail = process.env.GMAIL_SENDER_EMAIL?.trim();
  if (!senderEmail || !EMAIL_PATTERN.test(senderEmail)) {
    const message = "GMAIL_SENDER_EMAIL is missing or invalid.";
    await writeSendLog(supabase, {
      zip_filename: zipFilename,
      account_key: accountKey,
      trade_date: tradeDate,
      to_email: toEmail,
      to_name: toName,
      status: "failed",
      error: message,
      message_id: null,
      sent_by_auth_user_id: user.id
    });
    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: message
      },
      { status: 500 }
    );
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (dryRun) {
    return Response.json({
      ok: true,
      provider: "gmail",
      dryRun: true
    });
  }

  const toAddress = toName ? `"${toName.replace(/"/g, "")}" <${toEmail}>` : toEmail;
  const subject = `Bill ${accountKey}${tradeDate ? ` ${tradeDate}` : ""}`;
  const text = `Hi ${toName ?? accountKey},\n\nAttached is your bill${
    tradeDate ? ` for ${tradeDate}` : ""
  }.\n\n— ALPHA-TECH X`;

  try {
    const { gmail } = getGmailClient();
    const raw = buildRawMimeMessage({
      from: senderEmail,
      to: toAddress,
      subject,
      text,
      filename,
      pdfBuffer
    });

    const sendResult = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });

    const messageId = sendResult.data.id ?? null;
    const threadId = sendResult.data.threadId ?? null;

    if (!messageId) {
      const message = "Failed to send email.";
      await writeSendLog(supabase, {
        zip_filename: zipFilename,
        account_key: accountKey,
        trade_date: tradeDate,
        to_email: toEmail,
        to_name: toName,
        status: "failed",
        error: message,
        message_id: null,
        sent_by_auth_user_id: user.id
      });

      return Response.json(
        {
          ok: false,
          provider: "gmail",
          error: message
        },
        { status: 500 }
      );
    }

    await writeSendLog(supabase, {
      zip_filename: zipFilename,
      account_key: accountKey,
      trade_date: tradeDate,
      to_email: toEmail,
      to_name: toName,
      status: "sent",
      error: null,
      message_id: messageId,
      sent_by_auth_user_id: user.id
    });

    return Response.json({
      ok: true,
      provider: "gmail",
      id: messageId,
      threadId,
      messageId
    });
  } catch (error) {
    const message = sanitizeErrorMessage(
      error instanceof Error && error.message.trim()
        ? error.message
        : "Failed to send email."
    );

    await writeSendLog(supabase, {
      zip_filename: zipFilename,
      account_key: accountKey,
      trade_date: tradeDate,
      to_email: toEmail,
      to_name: toName,
      status: "failed",
      error: message,
      message_id: null,
      sent_by_auth_user_id: user.id
    });

    console.error("send-email failed", {
      account_key: accountKey,
      to: maskEmail(toEmail),
      provider: "gmail"
    });

    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: message
      },
      { status: 500 }
    );
  }
}
