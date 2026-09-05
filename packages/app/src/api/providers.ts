/**
 * 🌐 SOCIAL PROVIDERS — Google (ID token) and X (OAuth2 code exchange).
 *
 * Both activate only when the matching env vars are set:
 *   Google: GOOGLE_CLIENT_ID (verification only — tokeninfo endpoint)
 *   X:      X_CLIENT_ID + X_CLIENT_SECRET (OAuth2 authorization-code flow)
 *
 * Google flow: frontend uses Google Identity Services → receives a JWT
 *   credential → POSTs it here → we verify via tokeninfo + aud check.
 * X flow:      frontend redirects to X's authorize URL → X redirects back
 *   with ?code= → frontend POSTs the code here → we exchange for a token
 *   and fetch the user profile.
 */

/** Verify a Google ID token via tokeninfo and return profile fields. */
export async function verifyGoogleIdToken(
  credential: string,
  expectedAud: string
): Promise<{ sub: string; email: string; name: string; picture: string }> {
  if (!expectedAud) throw new Error("GOOGLE_CLIENT_ID not configured");
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Google rejected the ID token");
  const info = (await res.json()) as {
    aud?: string; sub?: string; email?: string; name?: string; picture?: string; error_description?: string;
  };
  if (info.aud !== expectedAud) throw new Error("token audience mismatch");
  if (!info.sub) throw new Error("missing subject");
  return { sub: info.sub, email: info.email ?? "", name: info.name ?? "", picture: info.picture ?? "" };
}

export interface XProfile {
  id: string;
  username: string;
  name: string;
}

/** Exchange an OAuth2 authorization code for an X access token. */
async function exchangeXCode(code: string, redirectUri: string, clientId: string, clientSecret: string, codeVerifier: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`X token exchange failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("X returned no access token");
  return data.access_token;
}

/** Fetch the authenticated X user profile. */
async function fetchXProfile(accessToken: string): Promise<XProfile> {
  const res = await fetch("https://api.twitter.com/2/users/me?user.fields=name,username", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`X profile fetch failed (${res.status})`);
  const data = (await res.json()) as { data?: { id?: string; username?: string; name?: string } };
  if (!data.data?.id) throw new Error("X returned no profile");
  return {
    id: data.data.id,
    username: data.data.username ?? "",
    name: data.data.name ?? data.data.username ?? "",
  };
}

/** Full X code → profile flow. Returns profile when configured, else null. */
export async function verifyXCode(
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<XProfile | null> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const token = await exchangeXCode(code, redirectUri, clientId, clientSecret, codeVerifier);
  return fetchXProfile(token);
}