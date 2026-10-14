import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  isHttpsRequest,
  sessionCookieOptions,
} from "@/lib/session";

/**
 * Clears the session cookie. Always answers 200 so a client that already lost
 * its cookie (or is on a stale tab) can still reach the login screen cleanly.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    ...sessionCookieOptions(
      isHttpsRequest(request.nextUrl.protocol, request.headers.get("x-forwarded-proto")),
    ),
    maxAge: 0,
  });
  return response;
}
