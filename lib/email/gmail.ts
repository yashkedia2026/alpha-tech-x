import "server-only";
import { google } from "googleapis";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is missing.`);
  }

  return value;
}

export function createGoogleOAuthClient(includeRefreshToken = true) {
  const clientId = getRequiredEnv("GMAIL_CLIENT_ID");
  const clientSecret = getRequiredEnv("GMAIL_CLIENT_SECRET");
  const redirectUri = getRequiredEnv("GMAIL_REDIRECT_URI");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  if (includeRefreshToken) {
    const refreshToken = getRequiredEnv("GMAIL_REFRESH_TOKEN");
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  return oauth2Client;
}

export function getGmailClient() {
  const oauth2Client = createGoogleOAuthClient(true);
  const senderEmail = getRequiredEnv("GMAIL_SENDER_EMAIL");
  const gmail = google.gmail({
    version: "v1",
    auth: oauth2Client
  });

  return {
    gmail,
    oauth2Client,
    senderEmail
  };
}
