"use client";

import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";

import { CaseCitations } from "@/components/chat/case-citations";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface ChatClientProps {
  matterId: number;
  matterLabel: string;
  viewAs: "firm" | "provider";
}

/**
 * The thread. `matterId` and `viewAs` ride on every request body so the server
 * rebinds the principal per turn — the client cannot widen its own scope by
 * editing a message, because the server never trusts what the client claims
 * beyond which matter and view it is asking for, both of which it re-checks.
 */
export function ChatClient({ matterId, matterLabel, viewAs }: ChatClientProps) {
  const runtime = useChatRuntime({
    transport: useMemo(
      () =>
        new AssistantChatTransport({
          api: "/api/chat",
          body: { matterId, matterLabel, viewAs },
        }),
      [matterId, matterLabel, viewAs],
    ),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <div className="flex min-h-0 flex-1 flex-col">
          <Thread components={{ ToolFallback: CaseCitations }} />
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}
