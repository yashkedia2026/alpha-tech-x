import { createGoogleOAuthClient } from "@/lib/email/gmail";

export const runtime = "nodejs";

function maskToken(token: string): string {
  if (token.length <= 8) {
    return `${token.slice(0, 2)}***`;
  }

  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim();

  if (!code) {
    return Response.json(
      {
        ok: false,
        provider: "gmail",
        error: "Missing OAuth code."
      },
      { status: 400 }
    );
  }

  try {
    const oauth2Client = createGoogleOAuthClient(false);
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token?.trim() ?? "";

    if (!refreshToken) {
      return Response.json(
        {
          ok: false,
          provider: "gmail",
          error:
            "Google did not return a refresh token. Re-run /api/google/oauth/start with consent."
        },
        { status: 400 }
      );
    }

    console.log("Google OAuth refresh token received", {
      refreshToken: maskToken(refreshToken)
    });

    return Response.json({
      ok: true,
      provider: "gmail",
      refreshToken,
      message:
        "Save this refreshToken to GMAIL_REFRESH_TOKEN in .env.local, then restart the app."
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "Failed to complete Google OAuth callback.";

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
