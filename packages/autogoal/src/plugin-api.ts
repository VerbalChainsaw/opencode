import { z } from "zod"

type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: unknown } }): void
  ask(input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: { [key: string]: unknown }
  }): Promise<void>
}

type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: unknown }
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}

tool.schema = z
