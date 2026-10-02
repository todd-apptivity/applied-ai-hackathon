"use client";

/**
 * The chat, as a rail on the dashboard.
 *
 * A thin wrapper rather than a second implementation: the matter and the
 * viewer are already resolved by the page, so this binds them and hands off to
 * the same `ChatClient` the standalone `/chat` page uses. `docs/chat.md` called
 * this out as the intended home for it.
 */

import { ChatClient } from "@/app/chat/chat-client";

export function CaseChatPanel({
  matterId,
  matterLabel,
  viewAs,
}: {
  matterId: number;
  matterLabel: string;
  viewAs: "firm" | "provider";
}) {
  return (
    <ChatClient
      // Remounting on a viewer switch drops the transcript, which is correct:
      // a provider must not inherit a thread answered for firm staff.
      key={`${matterId}:${viewAs}`}
      matterId={matterId}
      matterLabel={matterLabel}
      viewAs={viewAs}
    />
  );
}
