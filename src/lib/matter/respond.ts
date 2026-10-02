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
    return clioErrorResponse(error);
  }
}
