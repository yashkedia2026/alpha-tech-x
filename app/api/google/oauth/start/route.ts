import { NextResponse } from "next/server";
import { createGoogleOAuthClient, GMAIL_SEND_SCOPE } from "@/lib/email/gmail";

export const runtime = "nodejs";

export async function GET() {
  try {
    const oauth2Client = createGoogleOAuthClient(false);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_SEND_SCOPE]
    });

    return NextResponse.redirect(authUrl);
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "Failed to start Google OAuth flow.";

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
