import {
  type ContentBlock,
  type Message,
  type ToolConfiguration,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import * as ops from "../files/operations.js";
import type { AIAgent, AgentEvent } from "./types.js";
import type { AgentAction } from "../files/types.js";
import type { TrackedBedrock } from "../billing/tracked-bedrock.js";
import { log, preview } from "../../lib/log.js";

const MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";
// Upper bound on agent loop iterations. Each round = one Bedrock call.
// Bumped from 10 after a 30-template bulk-create request exhausted the
// budget. The real fix is parallel tool use (see the system prompt) —
// this is just a safety net for cases where Claude linearizes anyway.
const MAX_ROUNDS = 25;

const toolConfig: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "read_file",
        description: "Read the content of a template file.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path to the file (e.g. 'mri-knee.md' or 'neuro/brain-mri.md')" },
            },
            required: ["path"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "write_file",
        description: "Create or overwrite a template file with the given content.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path for the file" },
              content: { type: "string", description: "The full file content" },
            },
            required: ["path", "content"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "delete_file",
        description: "Delete a template file.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path of the file to delete" },
            },
            required: ["path"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "move_file",
        description: "Move or rename a template file.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              from: { type: "string", description: "Current relative path" },
              to: { type: "string", description: "New relative path" },
            },
            required: ["from", "to"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "list_files",
        description: "List files and folders at a directory level. Pass empty string for root.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path to list (e.g. '' for root, 'neuro' for a subfolder)" },
            },
            required: ["path"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "create_folder",
        description:
          "Create an empty folder. Prefer creating files directly at a nested path (write_file with 'rm/mri-knee.md') — the parent folders then appear automatically. Use this tool only when the user explicitly asks to create an empty folder to populate later.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path for the new folder (e.g. 'rm' or 'neuro/reports')" },
            },
            required: ["path"],
          },
        },
      },
    },
  ],
};

async function executeTool(
  userId: string,
  toolName: string,
  input: Record<string, string>,
): Promise<{ result: string; action: AgentAction | null }> {
  switch (toolName) {
    case "read_file": {
      const content = await ops.cat(userId, input.path);
      return {
        result: content,
        action: null, // reads don't count as mutations
      };
    }
    case "write_file": {
      await ops.write(userId, input.path, input.content);
      return {
        result: `Written to ${input.path}`,
        action: { tool: "write_file", path: input.path, summary: `Wrote ${input.path}` },
      };
    }
    case "delete_file": {
      await ops.rm(userId, input.path);
      return {
        result: `Deleted ${input.path}`,
        action: { tool: "delete_file", path: input.path, summary: `Deleted ${input.path}` },
      };
    }
    case "move_file": {
      await ops.mv(userId, input.from, input.to);
      return {
        result: `Moved ${input.from} → ${input.to}`,
        action: { tool: "move_file", path: input.to, summary: `Moved ${input.from} → ${input.to}` },
      };
    }
    case "list_files": {
      const entries = await ops.ls(userId, input.path);
      const listing = entries
        .map((e) => `${e.isDirectory ? "[dir] " : ""}${e.path}`)
        .join("\n");
      return {
        result: listing || "(empty directory)",
        action: null,
      };
    }
    case "create_folder": {
      // S3 has no real folders — ops.mkdir writes a zero-byte placeholder
      // key ending in "/". The `ls` helpers already filter those out of
      // file listings (so the placeholder itself is invisible) but the
      // folder shows up via CommonPrefixes. Net effect: Claude can create
      // an empty folder and the user sees it in the tree, but the marker
      // object never appears as a file.
      await ops.mkdir(userId, input.path);
      return {
        result: `Created folder ${input.path}`,
        action: {
          tool: "create_folder",
          path: input.path,
          summary: `Created folder ${input.path}`,
        },
      };
    }
    default:
      return { result: `Unknown tool: ${toolName}`, action: null };
  }
}

export function makeBedrockAgent(tracker: TrackedBedrock): AIAgent {
  return {
    async *executeFileOperations(
      userId: string,
      message: string,
      existingFiles: string[],
      conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
    ): AsyncGenerator<AgentEvent> {
      const fileList = existingFiles.map((f) => `- ${f}`).join("\n");

      // Two important properties of this prompt:
      //   1. "Respond in the same language..." — without this, Sonnet often
      //      replies in English even when the user wrote Spanish, then leaks
      //      tool descriptions verbatim from this prompt as filler text.
      //   2. "Never mention tool names..." — keeps internal vocabulary
      //      (read_file, write_file, etc.) out of user-facing summaries.
      const systemPrompt = `You are a template file manager. You help users create, edit, move, and delete template files.

Current files:
${fileList || "(no files yet)"}

Rules for your responses:
- Respond in the same language the user writes in. If they write in Spanish, respond in Spanish; in French, respond in French; and so on.
- Never mention tool names (read_file, write_file, list_files, move_file, delete_file, create_folder), tool parameter names, or any of the internal options described to you. Describe what you did in plain natural language as if you performed the actions yourself.
- ACT ONLY ON THE MOST RECENT USER MESSAGE. Earlier turns in the conversation are context — use them to resolve references like "those files", "that report", or "the one I just made", but do NOT re-execute actions that prior assistant turns already performed. The "Current files" list above is the source of truth for what exists; if a file appears there, it already exists and you do not need to recreate it. Only re-do work if the user explicitly asks you to.
- For bulk operations (creating, writing, moving, or deleting multiple files), issue several tool calls in parallel in the same turn — this is much faster than one per turn. BUT keep each turn under roughly 6-8 tool calls so your response fits in the output token budget. If the user asks for more files than that, do the first batch this turn, then continue with the next batch in the following turn; your previous tool calls will have already been executed, so just pick up where you left off. Do NOT re-do work already completed.
- When a task requires reading several files before acting (e.g. "rename these based on their contents"), front-load ALL the reads into the first turn as parallel read_file calls, then do the writes/moves in subsequent turns. Do NOT interleave reads and writes across many turns — that doubles the number of round trips and can cause the request to time out.
- Keep any accompanying text short (one sentence or none) during bulk operations so the tool calls themselves have room to fit.
- After the request is fully complete, give one short summary of what changed.
- Use the provided tools to accomplish the request — but never describe them to the user.`;

      // Thread prior turns so multi-turn references like "now move it to
      // neuro/" work. Frontend stores plain {role, text}; we wrap each as
      // a single text block. Tool-use details from prior rounds are not
      // re-included (they don't survive across requests anyway), but the
      // assistant's natural-language summary — which already includes the
      // action list — is enough context.
      const messages: Message[] = [];
      if (conversationHistory && conversationHistory.length > 0) {
        for (const m of conversationHistory) {
          messages.push({ role: m.role, content: [{ text: m.text }] });
        }
      }
      messages.push({ role: "user", content: [{ text: message }] });

      log.info("agent.start", {
        requestId: tracker.requestId,
        userId,
        historyTurns: conversationHistory?.length ?? 0,
        existingFileCount: existingFiles.length,
        messagePreview: preview(message, 200),
      });

      const actions: AgentAction[] = [];

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await tracker.converse(
          {
            modelId: MODEL_ID,
            messages,
            system: [{ text: systemPrompt }],
            toolConfig,
            // 8192 leaves enough headroom for ~6-8 parallel write_file
            // calls per turn (prompt caps the batch size to match). The
            // previous 4096 ceiling hit `max_tokens` mid-response on
            // bulk-create requests — see agent.round.max_tokens handling
            // further down for why that's not necessarily fatal anymore.
            inferenceConfig: {
              maxTokens: 8192,
              temperature: 0.2,
            },
          },
          { action: "agent_round", agentRound: round + 1 },
        );

        const stopReason = response.stopReason;
        const assistantContent = response.output?.message?.content || [];

        // Add assistant response to conversation
        messages.push({ role: "assistant", content: assistantContent as ContentBlock[] });

        // Walk the response for tool uses and execute them. We do this
        // BEFORE deciding whether to bail on the loop, because Bedrock
        // can return `stopReason: max_tokens` with several valid tool_use
        // blocks already emitted — previously we'd discard them and exit,
        // which is how "created 30 templates" silently produced 0 files.
        const toolResults: ContentBlock[] = [];
        const roundToolCalls: string[] = [];

        for (const block of assistantContent) {
          if (!("toolUse" in block) || !block.toolUse) continue;

          const { toolUseId, name, input } = block.toolUse;
          if (!toolUseId || !name) continue;

          roundToolCalls.push(name);

          try {
            const { result, action } = await executeTool(
              userId,
              name,
              input as Record<string, string>,
            );
            if (action) {
              actions.push(action);
              // Stream the action to the client right away. The frontend
              // shows it under the in-progress assistant bubble so the
              // user sees real progress instead of staring at a spinner
              // while later rounds back off and retry.
              yield {
                type: "tool",
                tool: action.tool,
                path: action.path,
                summary: action.summary,
              };
            }

            log.info("agent.tool.ok", {
              requestId: tracker.requestId,
              userId,
              round: round + 1,
              tool: name,
              input: preview(input, 200),
              resultPreview: preview(result, 200),
            });

            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: result } as ToolResultContentBlock],
              },
            } as ContentBlock);
          } catch (err) {
            log.error("agent.tool.failed", err, {
              requestId: tracker.requestId,
              userId,
              round: round + 1,
              tool: name,
              input: preview(input, 200),
            });

            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}` } as ToolResultContentBlock],
                status: "error",
              },
            } as ContentBlock);
          }
        }

        log.info("agent.round", {
          requestId: tracker.requestId,
          userId,
          round: round + 1,
          stopReason,
          toolCount: roundToolCalls.length,
          toolsCalled: roundToolCalls,
        });

        // Decide whether to continue or terminate. `end_turn` and
        // anything unknown → terminate cleanly. `tool_use` → normal
        // case, feed results back and loop. `max_tokens` → Claude ran
        // out of output budget; if it managed to get any tool_use
        // blocks out, loop again so it can continue from where it left
        // off (each turn makes concrete progress because executed tool
        // results are now in the history). If we got no tool uses on
        // max_tokens, the round produced only text and looping would
        // just waste budget — terminate with a warning instead.
        const cutOffMidBatch =
          stopReason === "max_tokens" && roundToolCalls.length > 0;

        if (stopReason !== "tool_use" && !cutOffMidBatch) {
          const textParts = assistantContent
            .filter((b): b is ContentBlock & { text: string } => "text" in b && typeof b.text === "string")
            .map((b) => b.text);

          log.info("agent.complete", {
            requestId: tracker.requestId,
            userId,
            roundsUsed: round + 1,
            stopReason,
            actionCount: actions.length,
            actions: actions.map((a) => a.tool),
          });

          const summary = textParts.join("\n").trim();
          const fallback =
            stopReason === "max_tokens"
              ? "Ran out of output space before producing any tool calls — try rephrasing into smaller steps."
              : "Done.";

          yield {
            type: "complete",
            message: summary || fallback,
            changedPaths: actions
              .map((a) => a.path)
              .filter((p): p is string => !!p),
          };
          return;
        }

        // Feed tool results back and loop for another round
        messages.push({ role: "user", content: toolResults });
      }

      // Max rounds reached
      log.warn("agent.max_rounds", {
        requestId: tracker.requestId,
        userId,
        actionCount: actions.length,
        actions: actions.map((a) => a.tool),
      });

      yield {
        type: "complete",
        message:
          "Reached maximum operation limit. Some changes may be incomplete.",
        changedPaths: actions
          .map((a) => a.path)
          .filter((p): p is string => !!p),
      };
    },
  };
}
