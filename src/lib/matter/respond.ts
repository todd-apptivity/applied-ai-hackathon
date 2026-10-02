/**
 * The GET handler behind both lawyer views: load the matter through the
 * configured source, fill the view's template, answer with the document.
 */

import { NextResponse } from "next/server";

import { ClioNotConnectedError } from "@/lib/clio/client";
import { clioErrorResponse } from "@/lib/clio/http-errors";

import { renderLawyerView, type LawyerViewKind } from "./render";
import { loadMatterView } from "./view";

export async function lawyerViewResponse(kind: LawyerViewKind, matterId: string, request: Request) {
  const id = Number(matterId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_matter_id" }, { status: 400 });
  }

  try {
    const view = await loadMatterView(id);
    return new Response(await renderLawyerView(kind, view), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Live case data: never stored by a browser or a proxy.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // Not connected is a setup step, not an error page.
    if (error instanceof ClioNotConnectedError) {
      return NextResponse.redirect(new URL("/clio", request.url));
    }
    return viewErrorPage(error);
  }
}

/**
 * A view is a page a person is looking at, so a failed read gets a page they
 * can act on, with the same status the JSON error would have carried.
 */
export function viewErrorPage(error: unknown): Response {
  const status = clioErrorResponse(error).status;
  const reason = error instanceof TypeError
    ? "Clio could not be reached. The connection timed out or was dropped."
    : "Clio answered with an error, so the case could not be read.";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Could not open the case</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f1e4;color:#10231f;font:16px/1.5 system-ui,sans-serif}main{max-width:26rem;padding:24px;text-align:center}h1{font:600 24px Georgia,serif;margin:0 0 8px}p{margin:0 0 18px;color:#4d5e58}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;background:#0e6b57;color:#fff;cursor:pointer}</style></head>
<body><main><h1>The case could not be opened</h1><p>${reason} Nothing is stored locally yet, so each view is read from Clio when it opens.</p><button onclick="location.reload()">Try again</button></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
