import { NextResponse } from "next/server";
import { ClioApiError, ClioNotConnectedError } from "./client";
import { ClioConfigError } from "./config";

/** Maps Clio layer failures onto JSON responses for the route handlers. */
export function clioErrorResponse(error: unknown): NextResponse {
  if (error instanceof ClioConfigError) {
    return NextResponse.json(
      { error: "not_configured", message: error.message },
      { status: 503 },
    );
  }
  if (error instanceof ClioNotConnectedError) {
    return NextResponse.json(
      { error: "not_connected", connectUrl: "/api/clio/connect" },
      { status: 401 },
    );
  }
  if (error instanceof ClioApiError) {
    return NextResponse.json(
      { error: "clio_api_error", status: error.status, message: error.message },
      { status: 502 },
    );
  }
  console.error("Clio read failed", error);
  return NextResponse.json(
    { error: "unexpected", message: (error as Error).message },
    { status: 500 },
  );
}
