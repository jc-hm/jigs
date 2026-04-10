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
const MAX_ROUNDS = 10;

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
- Never mention tool names (read_file, write_file, list_files, move_file, delete_file), tool parameter names, or any of the internal options described to you. Describe what you did in plain natural language as if you performed the actions yourself.
- After completing the user's request, give one short summary of what changed.
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
            inferenceConfig: {
              maxTokens: 4096,
              temperature: 0.2,
            },
          },
          { action: "agent_round", agentRound: round + 1 },
        );

        const stopReason = response.stopReason;
        const assistantContent = response.output?.message?.content || [];

        // Add assistant response to conversation
        messages.push({ role: "assistant", content: assistantContent as ContentBlock[] });

        // If model stopped without requesting tools, we're done
        if (stopReason !== "tool_use") {
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

          yield {
            type: "complete",
            message: textParts.join("\n") || "Done.",
            changedPaths: actions
              .map((a) => a.path)
              .filter((p): p is string => !!p),
          };
          return;
        }

        // Execute tool calls
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
          toolsCalled: roundToolCalls,
        });

        // Feed tool results back
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
