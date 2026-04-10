import {
  type ContentBlock,
  type Message,
  type ToolConfiguration,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import * as ops from "../files/operations.js";
import type { AIAgent } from "./types.js";
import type { AgentAction, AgentResult } from "../files/types.js";
import type { TrackedBedrock } from "../billing/tracked-bedrock.js";

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
    async executeFileOperations(
      userId: string,
      message: string,
      existingFiles: string[],
    ): Promise<AgentResult> {
      const fileList = existingFiles.map((f) => `- ${f}`).join("\n");

      const systemPrompt = `You are a template file manager. You help users create, edit, move, and delete template files.

Current files:
${fileList || "(no files yet)"}

Use the provided tools to accomplish the user's request. After making changes, respond with a brief summary of what you did.`;

      const messages: Message[] = [
        { role: "user", content: [{ text: message }] },
      ];

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

          return {
            actions,
            message: textParts.join("\n") || "Done.",
            changedPaths: actions.map((a) => a.path).filter((p): p is string => !!p),
          };
        }

        // Execute tool calls
        const toolResults: ContentBlock[] = [];

        for (const block of assistantContent) {
          if (!("toolUse" in block) || !block.toolUse) continue;

          const { toolUseId, name, input } = block.toolUse;
          if (!toolUseId || !name) continue;

          try {
            const { result, action } = await executeTool(
              userId,
              name,
              input as Record<string, string>,
            );
            if (action) actions.push(action);

            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: result } as ToolResultContentBlock],
              },
            } as ContentBlock);
          } catch (err) {
            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: `Error: ${err instanceof Error ? err.message : String(err)}` } as ToolResultContentBlock],
                status: "error",
              },
            } as ContentBlock);
          }
        }

        // Feed tool results back
        messages.push({ role: "user", content: toolResults });
      }

      // Max rounds reached
      return {
        actions,
        message: "Reached maximum operation limit. Some changes may be incomplete.",
        changedPaths: actions.map((a) => a.path).filter((p): p is string => !!p),
      };
    },
  };
}
