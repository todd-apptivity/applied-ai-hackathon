# Case chat

`/chat` is a grounded conversation about one matter. The assistant cannot answer from general knowledge: it has one tool, `search_case_file`, and the system prompt requires a citation on every factual sentence. Expanding a search in the transcript shows the exact passages the answer was built from, each with a deep link into Clio.

It is a standalone page for now, and is meant to become a side panel on the case dashboard.

## The request path

```
/chat page  ──>  POST /api/chat  ──>  streamText(model, tools)
                       │                      │
                  getPrincipal()         search_case_file
                   (STUB auth)                │
                                       searchForPrincipal()  ← the only retrieval seam
                                              │
                                    canAccessMatter → resolveKindFilter
                                              │
                                      search()  (hybrid + rerank)
                                              │
                                        filterHits()
                                              │
                                     passages + withheld count
```

| File | Role |
| --- | --- |
| `src/app/chat/page.tsx` | Picks a matter from `indexStats()`, renders setup states when nothing is indexed |
| `src/app/chat/chat-client.tsx` | `useChatRuntime` + `AssistantChatTransport`, sends `matterId` and `viewAs` on every turn |
| `src/components/chat/case-citations.tsx` | Renders a tool call as citation cards, wired into the thread's `ToolFallback` slot |
| `src/app/api/chat/route.ts` | Binds the principal, builds the tool, streams the answer |
| `src/lib/chat/tool.ts` | `search_case_file`, declared from JSON Schema |
| `src/lib/chat/prompt.ts` | Grounding and citation rules; separate scope text per viewer |
| `src/lib/ai/model.ts` | The only place a model provider is named |
| `src/lib/permissions/` | Who is asking and what they may read |

## Citations

A passage carries a `ref` built from Clio's own ids — `note:4821`, `document_page:9912#p47` — and the prompt tells the model to write that ref in brackets after each claim. Because refs come from Clio ids rather than per-call numbering, the same passage keeps the same ref across searches and across turns.

The tool returns structured JSON rather than a formatted string, so the UI and the model read the same objects. A passage arrives with its Clio URL already built, which keeps `src/lib/chat/types.ts` free of anything the browser bundle cannot import.

## Permissions

The index is unsegmented — attorney notes, the client's date of birth, and medical records share one `sources` table — so every read is attributed to a `Principal` and filtered.

**Firm staff** read everything in their matters. **A provider** is scoped to one matter and to a default-deny slice of it:

- Allowed kinds: `matter`, `task`, `calendar_entry`, `document`, `document_page`.
- Never allowed: `note` (work product), `communication` (internal threads), `activity` (time and expenses, which read through to case value), `custom_field` (coverage limits, case value), `contact` (other providers, the client's identifiers).
- `allowedKinds()` **intersects** with that baseline, so a share that approves `note` still yields no notes. Approvals narrow; they never widen.
- Passages that survive the kind filter are screened for the PRD's default-deny topics and dropped if they trip one.

Filtering happens **before the passages reach the model**, not on the way to the screen. Filtering only at render would mean the model had already read the withheld text and could paraphrase it into prose that passes every check the UI makes. The model can only cite what it was handed, so the handed set is the boundary. The UI then shows a withheld *count* and topic list — never the content.

### What is stubbed

Two things, both marked with `TODO` at their definitions:

1. **`getPrincipal()` is not authentication.** The viewer comes from `?as=firm|provider`. Anyone can type it. Real version: a staff session for firm users, and a `provider_shares` row keyed by an unguessable, revocable share token for providers.
2. **`screenText()` is a keyword pass**, not redaction. It fails closed on the obvious phrasings and will miss paraphrase. The PRD's real design is an attorney-approved snapshot: preview, toggle fields, publish frozen — so what a provider sees is an approved artifact, not a classifier's output.

Treat provider mode as a demonstration of where the checks go, not as a privacy boundary that has been tested. The rules themselves are real and covered by `tests/permissions.test.ts` (`npm test`), including the PRD's "fields outside the approved set: 0" target.

## Swapping in a local model

`src/lib/ai/model.ts` is the only file that names a provider, and the tool is declared from JSON Schema rather than a provider-specific type, so a local Qwen swap is env-only:

```sh
CHAT_PROVIDER=local
LOCAL_LLM_BASE_URL=http://localhost:8000/v1   # vLLM, llama.cpp, or Ollama
LOCAL_LLM_MODEL=qwen3-32b-instruct
```

Expect two differences. Small models are less reliable at multi-step tool use, so `maxToolSteps()` drops from 6 to 4 — raise it with `CHAT_MAX_STEPS` if yours holds up. And there is no prompt caching, so the system prompt is re-read every turn.

Retrieval still calls Voyage for embeddings and reranking; `CHAT_PROVIDER` only moves the chat model.

## Running it

```sh
npm run rag:seed -- --matter <matter id>   # pull from Clio
npm run rag:embed                           # embed the chunks
npm run rag:status                          # confirm embedded > 0
npm run dev                                 # then open /chat
```

`/chat` reports which step is missing if the index is empty or `VOYAGE_API_KEY` is unset.

## Known gaps

- **The withheld counter under-reports.** Denied kinds are excluded in the SQL query rather than dropped afterwards, which is the right order — privileged text is never read into memory — but it means `withheld.byKind` is almost always 0 and the UI's "N passages withheld" reflects topic screening only. A provider search that silently skipped forty notes still reports zero. Counting them honestly needs a separate `COUNT(*)` per denied kind, which is cheap but not wired up.
- **The matter-scope 403 is unreachable in the stub.** `getPrincipal(viewAs, matterId)` builds the provider principal *from the requested matter*, so `canAccessMatter` can never fail at the route. The check and its tests are real — a real share token carries its own `matter_id`, independent of the request — but the running app cannot exercise that branch until auth is real. The per-hit cross-matter filter in `filterHits` does run.
- **No persistence.** Threads live in memory; a reload starts a new conversation. Multi-thread needs a `RemoteThreadListAdapter` or Assistant Cloud.
- **`sourceLink()` is duplicated** between `src/lib/chat/source-link.ts` and `src/app/api/rag/search/route.ts`. The copy was deliberate — that route was under active edit — and the two should be consolidated.
- **Citation refs are not yet clickable in the prose.** The model writes `[note:4821]` as text; the cards below carry the links. Mapping inline refs to anchors is the obvious next step.
- **No eval.** Whether the agent actually cites correctly, and whether provider mode leaks under adversarial questioning, is untested beyond the unit tests on the rules.
